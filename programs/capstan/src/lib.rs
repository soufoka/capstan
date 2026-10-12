//! Capstan: escrow-backed advances for cross-border trade.
//!
//! An importer locks the full purchase price of an order in a per-deal escrow.
//! Once the supplier posts proof of shipment, the supplier can draw an advance
//! from a shared liquidity pool, collateralised by the locked escrow. When the
//! escrow releases (importer confirms delivery, or the inspection window
//! lapses), the program repays the pool first (principal + fee) and pays the
//! rest to the supplier. Disputes are settled by the pool's arbiter, and the
//! supplier's share still repays the pool before anything else.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("2ATx5cQKsBZEyzxKfwyhkNM3KgWyGQGqykqxnfz4UBPU");

pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const SHARE_MINT_SEED: &[u8] = b"shares";
pub const DEAL_SEED: &[u8] = b"deal";
pub const DEAL_VAULT_SEED: &[u8] = b"deal_vault";
pub const FAUCET_SEED: &[u8] = b"faucet";

pub const BPS: u64 = 10_000;
pub const MAX_FEE_BPS: u16 = 2_000;
pub const MIN_RELEASE_WINDOW: i64 = 30;
pub const MAX_RELEASE_WINDOW: i64 = 180 * 24 * 60 * 60;
pub const MAX_FAUCET_UNITS: u64 = 100_000;

#[program]
pub mod capstan {
    use super::*;

    /// Creates a liquidity pool for one stablecoin mint.
    pub fn init_pool(
        ctx: Context<InitPool>,
        advance_fee_bps: u16,
        max_advance_bps: u16,
        arbiter: Pubkey,
    ) -> Result<()> {
        require!(advance_fee_bps <= MAX_FEE_BPS, CapstanError::InvalidBps);
        require!(
            max_advance_bps > 0 && (max_advance_bps as u64) <= BPS,
            CapstanError::InvalidBps
        );
        let pool = &mut ctx.accounts.pool;
        pool.admin = ctx.accounts.admin.key();
        pool.arbiter = arbiter;
        pool.mint = ctx.accounts.mint.key();
        pool.share_mint = ctx.accounts.share_mint.key();
        pool.vault = ctx.accounts.pool_vault.key();
        pool.advance_fee_bps = advance_fee_bps;
        pool.max_advance_bps = max_advance_bps;
        pool.outstanding_principal = 0;
        pool.fees_earned = 0;
        pool.losses = 0;
        pool.advances_paid = 0;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Liquidity provider deposits stablecoins and receives pool shares.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, CapstanError::ZeroAmount);
        let pool = &ctx.accounts.pool;
        let total_assets = pool_assets(pool, &ctx.accounts.pool_vault);
        let supply = ctx.accounts.share_mint.supply;
        let shares = if supply == 0 || total_assets == 0 {
            amount
        } else {
            mul_div(amount, supply, total_assets)?
        };
        require!(shares > 0, CapstanError::ZeroAmount);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.provider_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                    authority: ctx.accounts.provider.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let mint_key = pool.mint;
        let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[pool.bump]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.provider_shares.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            shares,
        )?;

        emit!(LiquidityDeposited {
            pool: ctx.accounts.pool.key(),
            provider: ctx.accounts.provider.key(),
            amount,
            shares,
        });
        Ok(())
    }

    /// Liquidity provider burns shares for their pro-rata stablecoins.
    /// Only idle liquidity can leave; capital lent out stays until repaid.
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        require!(shares > 0, CapstanError::ZeroAmount);
        let pool = &ctx.accounts.pool;
        let total_assets = pool_assets(pool, &ctx.accounts.pool_vault);
        let supply = ctx.accounts.share_mint.supply;
        let amount = mul_div(shares, total_assets, supply)?;
        require!(amount > 0, CapstanError::ZeroAmount);
        require!(
            amount <= ctx.accounts.pool_vault.amount,
            CapstanError::InsufficientLiquidity
        );

        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.provider_shares.to_account_info(),
                    authority: ctx.accounts.provider.to_account_info(),
                },
            ),
            shares,
        )?;

        let mint_key = pool.mint;
        let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[pool.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.pool_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.provider_token.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(LiquidityWithdrawn {
            pool: ctx.accounts.pool.key(),
            provider: ctx.accounts.provider.key(),
            amount,
            shares,
        });
        Ok(())
    }

    /// Importer opens a deal and locks the full order amount in escrow.
    pub fn create_deal(
        ctx: Context<CreateDeal>,
        deal_id: u64,
        amount: u64,
        ship_by: i64,
        release_window: i64,
        terms_hash: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, CapstanError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(ship_by > now, CapstanError::InvalidDeadline);
        require!(
            (MIN_RELEASE_WINDOW..=MAX_RELEASE_WINDOW).contains(&release_window),
            CapstanError::InvalidDeadline
        );
        require_keys_neq!(
            ctx.accounts.supplier.key(),
            ctx.accounts.importer.key(),
            CapstanError::SameParty
        );

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.importer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.deal_vault.to_account_info(),
                    authority: ctx.accounts.importer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let deal_key = ctx.accounts.deal.key();
        let vault_key = ctx.accounts.deal_vault.key();
        let importer_key = ctx.accounts.importer.key();
        let supplier_key = ctx.accounts.supplier.key();
        let pool_key = ctx.accounts.pool.key();
        let mint_key = ctx.accounts.mint.key();
        let deal = &mut ctx.accounts.deal;
        deal.importer = importer_key;
        deal.supplier = supplier_key;
        deal.pool = pool_key;
        deal.mint = mint_key;
        deal.vault = vault_key;
        deal.deal_id = deal_id;
        deal.amount = amount;
        deal.terms_hash = terms_hash;
        deal.shipment_hash = [0u8; 32];
        deal.created_at = now;
        deal.ship_by = ship_by;
        deal.release_window = release_window;
        deal.shipped_at = 0;
        deal.advance_principal = 0;
        deal.advance_fee = 0;
        deal.supplier_paid = 0;
        deal.importer_refunded = 0;
        deal.pool_repaid = 0;
        deal.state = DealState::Funded;
        deal.bump = ctx.bumps.deal;

        emit!(DealCreated {
            deal: deal_key,
            importer: deal.importer,
            supplier: deal.supplier,
            amount,
            ship_by,
        });
        Ok(())
    }

    /// Supplier records proof of shipment (hash of the bill of lading or
    /// tracking record). Starts the importer's inspection window.
    pub fn mark_shipped(ctx: Context<SupplierAction>, shipment_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deal_key = ctx.accounts.deal.key();
        let deal = &mut ctx.accounts.deal;
        require!(deal.state == DealState::Funded, CapstanError::InvalidState);
        require!(now <= deal.ship_by, CapstanError::ShipDeadlinePassed);
        require!(shipment_hash != [0u8; 32], CapstanError::MissingProof);
        deal.shipment_hash = shipment_hash;
        deal.shipped_at = now;
        deal.state = DealState::Shipped;
        emit!(DealShipped {
            deal: deal_key,
            shipment_hash,
            release_at: now + deal.release_window,
        });
        Ok(())
    }

    /// Supplier draws an advance from the pool against the locked escrow.
    pub fn request_advance(ctx: Context<RequestAdvance>, amount: u64) -> Result<()> {
        require!(amount > 0, CapstanError::ZeroAmount);
        let pool = &ctx.accounts.pool;
        let deal = &ctx.accounts.deal;
        require!(deal.state == DealState::Shipped, CapstanError::InvalidState);
        require!(deal.advance_principal == 0, CapstanError::AdvanceAlreadyTaken);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now < deal.shipped_at + deal.release_window,
            CapstanError::WindowClosed
        );
        let cap = mul_div(deal.amount, pool.max_advance_bps as u64, BPS)?;
        require!(amount <= cap, CapstanError::AdvanceTooLarge);
        require!(
            amount <= ctx.accounts.pool_vault.amount,
            CapstanError::InsufficientLiquidity
        );
        let fee = mul_div(amount, pool.advance_fee_bps as u64, BPS)?;

        let mint_key = pool.mint;
        let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[pool.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.pool_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.supplier_token.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.outstanding_principal = pool
            .outstanding_principal
            .checked_add(amount)
            .ok_or(CapstanError::MathOverflow)?;
        pool.advances_paid = pool.advances_paid.saturating_add(1);

        let deal_key = ctx.accounts.deal.key();
        let deal = &mut ctx.accounts.deal;
        deal.advance_principal = amount;
        deal.advance_fee = fee;

        emit!(AdvancePaid {
            deal: deal_key,
            supplier: deal.supplier,
            principal: amount,
            fee,
        });
        Ok(())
    }

    /// Importer confirms delivery: escrow repays the pool, then pays the supplier.
    pub fn confirm_delivery(ctx: Context<Settle>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.caller.key(),
            ctx.accounts.deal.importer,
            CapstanError::Unauthorized
        );
        require!(
            ctx.accounts.deal.state == DealState::Shipped,
            CapstanError::InvalidState
        );
        settle(ctx.accounts, BPS as u16, DealState::Released)
    }

    /// Anyone can release the escrow once the inspection window has lapsed
    /// without a dispute. Protects the supplier (and the pool) from a silent importer.
    pub fn auto_release(ctx: Context<Settle>) -> Result<()> {
        let deal = &ctx.accounts.deal;
        require!(deal.state == DealState::Shipped, CapstanError::InvalidState);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= deal.shipped_at + deal.release_window,
            CapstanError::WindowStillOpen
        );
        settle(ctx.accounts, BPS as u16, DealState::Released)
    }

    /// Importer disputes the shipment inside the inspection window.
    pub fn open_dispute(ctx: Context<ImporterAction>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deal_key = ctx.accounts.deal.key();
        let deal = &mut ctx.accounts.deal;
        require!(deal.state == DealState::Shipped, CapstanError::InvalidState);
        require!(
            now < deal.shipped_at + deal.release_window,
            CapstanError::WindowClosed
        );
        deal.state = DealState::Disputed;
        emit!(DealDisputed { deal: deal_key });
        Ok(())
    }

    /// The pool's arbiter splits the escrow. The supplier's share repays the
    /// pool first; any shortfall is booked as a pool loss.
    pub fn resolve_dispute(ctx: Context<Settle>, supplier_bps: u16) -> Result<()> {
        require!((supplier_bps as u64) <= BPS, CapstanError::InvalidBps);
        require_keys_eq!(
            ctx.accounts.caller.key(),
            ctx.accounts.pool.arbiter,
            CapstanError::Unauthorized
        );
        require!(
            ctx.accounts.deal.state == DealState::Disputed,
            CapstanError::InvalidState
        );
        settle(ctx.accounts, supplier_bps, DealState::Resolved)
    }

    /// Importer takes the money back if the supplier never shipped in time.
    pub fn refund_unshipped(ctx: Context<Settle>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.caller.key(),
            ctx.accounts.deal.importer,
            CapstanError::Unauthorized
        );
        let deal = &ctx.accounts.deal;
        require!(deal.state == DealState::Funded, CapstanError::InvalidState);
        let now = Clock::get()?.unix_timestamp;
        require!(now > deal.ship_by, CapstanError::ShipDeadlineNotReached);
        settle(ctx.accounts, 0, DealState::Refunded)
    }

    /// Devnet helper: mints test stablecoins from a mint whose authority is
    /// this program's faucet PDA. Worthless by construction on any cluster.
    pub fn faucet(ctx: Context<Faucet>, amount: u64) -> Result<()> {
        let cap = MAX_FAUCET_UNITS
            .checked_mul(10u64.pow(ctx.accounts.mint.decimals as u32))
            .ok_or(CapstanError::MathOverflow)?;
        require!(amount > 0 && amount <= cap, CapstanError::AdvanceTooLarge);
        let seeds: &[&[u8]] = &[FAUCET_SEED, &[ctx.bumps.faucet_authority]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient_token.to_account_info(),
                    authority: ctx.accounts.faucet_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }
}

/// Splits the escrow: `supplier_bps` of it belongs to the supplier, who first
/// repays any outstanding advance; the remainder goes back to the importer.
fn settle(a: &mut Settle, supplier_bps: u16, final_state: DealState) -> Result<()> {
    let escrow = a.deal_vault.amount;
    let supplier_share = mul_div(escrow, supplier_bps as u64, BPS)?;
    let importer_share = escrow - supplier_share;
    let principal = a.deal.advance_principal;
    let owed = principal
        .checked_add(a.deal.advance_fee)
        .ok_or(CapstanError::MathOverflow)?;
    let to_pool = supplier_share.min(owed);
    let to_supplier = supplier_share - to_pool;

    let importer_key = a.deal.importer;
    let id_bytes = a.deal.deal_id.to_le_bytes();
    let bump = [a.deal.bump];
    let seeds: &[&[u8]] = &[DEAL_SEED, importer_key.as_ref(), &id_bytes, &bump];

    let pool_vault = a.pool_vault.to_account_info();
    let supplier_token = a.supplier_token.to_account_info();
    let importer_token = a.importer_token.to_account_info();
    pay_from_deal(a, pool_vault, to_pool, seeds)?;
    pay_from_deal(a, supplier_token, to_supplier, seeds)?;
    pay_from_deal(a, importer_token, importer_share, seeds)?;

    let pool = &mut a.pool;
    if principal > 0 {
        pool.outstanding_principal = pool.outstanding_principal.saturating_sub(principal);
        if to_pool >= principal {
            pool.fees_earned = pool.fees_earned.saturating_add(to_pool - principal);
        } else {
            pool.losses = pool.losses.saturating_add(principal - to_pool);
        }
    }

    let deal_key = a.deal.key();
    let deal = &mut a.deal;
    deal.pool_repaid = to_pool;
    deal.supplier_paid = to_supplier;
    deal.importer_refunded = importer_share;
    deal.state = final_state;

    emit!(DealSettled {
        deal: deal_key,
        state: final_state,
        to_pool,
        to_supplier,
        to_importer: importer_share,
    });
    Ok(())
}

fn pay_from_deal<'info>(
    a: &Settle<'info>,
    to: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.deal_vault.to_account_info(),
                mint: a.mint.to_account_info(),
                to,
                authority: a.deal.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        a.mint.decimals,
    )
}

/// Pool assets = idle liquidity + principal currently lent to suppliers.
fn pool_assets(pool: &Pool, vault: &InterfaceAccount<TokenAccount>) -> u64 {
    vault.amount.saturating_add(pool.outstanding_principal)
}

fn mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c > 0, CapstanError::MathOverflow);
    let v = (a as u128)
        .checked_mul(b as u128)
        .ok_or(CapstanError::MathOverflow)?
        / (c as u128);
    u64::try_from(v).map_err(|_| error!(CapstanError::MathOverflow))
}

// ---------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub arbiter: Pubkey,
    pub mint: Pubkey,
    pub share_mint: Pubkey,
    pub vault: Pubkey,
    pub advance_fee_bps: u16,
    pub max_advance_bps: u16,
    pub outstanding_principal: u64,
    pub fees_earned: u64,
    pub losses: u64,
    pub advances_paid: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Deal {
    pub importer: Pubkey,
    pub supplier: Pubkey,
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub deal_id: u64,
    pub amount: u64,
    pub terms_hash: [u8; 32],
    pub shipment_hash: [u8; 32],
    pub created_at: i64,
    pub ship_by: i64,
    pub release_window: i64,
    pub shipped_at: i64,
    pub advance_principal: u64,
    pub advance_fee: u64,
    pub pool_repaid: u64,
    pub supplier_paid: u64,
    pub importer_refunded: u64,
    pub state: DealState,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum DealState {
    Funded,
    Shipped,
    Disputed,
    Released,
    Resolved,
    Refunded,
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = admin,
        seeds = [POOL_VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        seeds = [SHARE_MINT_SEED, pool.key().as_ref()],
        bump,
        mint::decimals = mint.decimals,
        mint::authority = pool,
        mint::token_program = token_program,
    )]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub provider: Signer<'info>,
    #[account(has_one = mint, has_one = share_mint)]
    pub pool: Box<Account<'info, Pool>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.vault)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = provider)]
    pub provider_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = share_mint, token::authority = provider)]
    pub provider_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub provider: Signer<'info>,
    #[account(has_one = mint, has_one = share_mint)]
    pub pool: Box<Account<'info, Pool>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.vault)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = provider)]
    pub provider_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = share_mint, token::authority = provider)]
    pub provider_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct CreateDeal<'info> {
    #[account(mut)]
    pub importer: Signer<'info>,
    /// CHECK: any wallet can be the supplier; it only receives funds.
    pub supplier: UncheckedAccount<'info>,
    #[account(has_one = mint)]
    pub pool: Box<Account<'info, Pool>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = importer,
        space = 8 + Deal::INIT_SPACE,
        seeds = [DEAL_SEED, importer.key().as_ref(), &deal_id.to_le_bytes()],
        bump,
    )]
    pub deal: Box<Account<'info, Deal>>,
    #[account(
        init,
        payer = importer,
        seeds = [DEAL_VAULT_SEED, deal.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = deal,
        token::token_program = token_program,
    )]
    pub deal_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = importer)]
    pub importer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SupplierAction<'info> {
    pub supplier: Signer<'info>,
    #[account(mut, has_one = supplier @ CapstanError::Unauthorized)]
    pub deal: Box<Account<'info, Deal>>,
}

#[derive(Accounts)]
pub struct ImporterAction<'info> {
    pub importer: Signer<'info>,
    #[account(mut, has_one = importer @ CapstanError::Unauthorized)]
    pub deal: Box<Account<'info, Deal>>,
}

#[derive(Accounts)]
pub struct RequestAdvance<'info> {
    pub supplier: Signer<'info>,
    #[account(mut, has_one = supplier @ CapstanError::Unauthorized, has_one = pool, has_one = mint)]
    pub deal: Box<Account<'info, Deal>>,
    #[account(mut, has_one = mint)]
    pub pool: Box<Account<'info, Pool>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.vault)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = supplier)]
    pub supplier_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    pub caller: Signer<'info>,
    #[account(mut, has_one = pool, has_one = mint)]
    pub deal: Box<Account<'info, Deal>>,
    #[account(mut, has_one = mint)]
    pub pool: Box<Account<'info, Pool>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = deal.vault)]
    pub deal_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.vault)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        constraint = supplier_token.owner == deal.supplier @ CapstanError::Unauthorized,
    )]
    pub supplier_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        constraint = importer_token.owner == deal.importer @ CapstanError::Unauthorized,
    )]
    pub importer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut, mint::authority = faucet_authority)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA that holds mint authority over test stablecoins.
    #[account(seeds = [FAUCET_SEED], bump)]
    pub faucet_authority: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint)]
    pub recipient_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ------------------------------------------------------------------ events

#[event]
pub struct LiquidityDeposited {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct LiquidityWithdrawn {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct DealCreated {
    pub deal: Pubkey,
    pub importer: Pubkey,
    pub supplier: Pubkey,
    pub amount: u64,
    pub ship_by: i64,
}

#[event]
pub struct DealShipped {
    pub deal: Pubkey,
    pub shipment_hash: [u8; 32],
    pub release_at: i64,
}

#[event]
pub struct AdvancePaid {
    pub deal: Pubkey,
    pub supplier: Pubkey,
    pub principal: u64,
    pub fee: u64,
}

#[event]
pub struct DealDisputed {
    pub deal: Pubkey,
}

#[event]
pub struct DealSettled {
    pub deal: Pubkey,
    pub state: DealState,
    pub to_pool: u64,
    pub to_supplier: u64,
    pub to_importer: u64,
}

// ------------------------------------------------------------------ errors

#[error_code]
pub enum CapstanError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Basis points out of range")]
    InvalidBps,
    #[msg("Deadline or window out of range")]
    InvalidDeadline,
    #[msg("Importer and supplier must be different wallets")]
    SameParty,
    #[msg("Signer is not allowed to perform this action")]
    Unauthorized,
    #[msg("Deal is not in the right state for this action")]
    InvalidState,
    #[msg("Shipping deadline has passed")]
    ShipDeadlinePassed,
    #[msg("Shipping deadline has not passed yet")]
    ShipDeadlineNotReached,
    #[msg("Proof of shipment is required")]
    MissingProof,
    #[msg("An advance was already drawn on this deal")]
    AdvanceAlreadyTaken,
    #[msg("Requested amount is above the allowed limit")]
    AdvanceTooLarge,
    #[msg("Not enough idle liquidity in the pool")]
    InsufficientLiquidity,
    #[msg("Inspection window is closed")]
    WindowClosed,
    #[msg("Inspection window is still open")]
    WindowStillOpen,
    #[msg("Math overflow")]
    MathOverflow,
}
