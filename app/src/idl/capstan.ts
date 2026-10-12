/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/capstan.json`.
 */
export type Capstan = {
  "address": "2ATx5cQKsBZEyzxKfwyhkNM3KgWyGQGqykqxnfz4UBPU",
  "metadata": {
    "name": "capstan",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Escrow-backed advances for cross-border trade on Solana"
  },
  "instructions": [
    {
      "name": "autoRelease",
      "docs": [
        "Anyone can release the escrow once the inspection window has lapsed",
        "without a dispute. Protects the supplier (and the pool) from a silent importer."
      ],
      "discriminator": [
        212,
        34,
        30,
        246,
        192,
        13,
        97,
        31
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "deal",
          "writable": true
        },
        {
          "name": "pool",
          "writable": true,
          "relations": [
            "deal"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "deal",
            "pool"
          ]
        },
        {
          "name": "dealVault",
          "writable": true
        },
        {
          "name": "poolVault",
          "writable": true
        },
        {
          "name": "supplierToken",
          "writable": true
        },
        {
          "name": "importerToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "confirmDelivery",
      "docs": [
        "Importer confirms delivery: escrow repays the pool, then pays the supplier."
      ],
      "discriminator": [
        11,
        109,
        227,
        53,
        179,
        190,
        88,
        155
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "deal",
          "writable": true
        },
        {
          "name": "pool",
          "writable": true,
          "relations": [
            "deal"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "deal",
            "pool"
          ]
        },
        {
          "name": "dealVault",
          "writable": true
        },
        {
          "name": "poolVault",
          "writable": true
        },
        {
          "name": "supplierToken",
          "writable": true
        },
        {
          "name": "importerToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "createDeal",
      "docs": [
        "Importer opens a deal and locks the full order amount in escrow."
      ],
      "discriminator": [
        198,
        212,
        144,
        151,
        97,
        56,
        149,
        113
      ],
      "accounts": [
        {
          "name": "importer",
          "writable": true,
          "signer": true
        },
        {
          "name": "supplier"
        },
        {
          "name": "pool"
        },
        {
          "name": "mint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "deal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "importer"
              },
              {
                "kind": "arg",
                "path": "dealId"
              }
            ]
          }
        },
        {
          "name": "dealVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "deal"
              }
            ]
          }
        },
        {
          "name": "importerToken",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "dealId",
          "type": "u64"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "shipBy",
          "type": "i64"
        },
        {
          "name": "releaseWindow",
          "type": "i64"
        },
        {
          "name": "termsHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "deposit",
      "docs": [
        "Liquidity provider deposits stablecoins and receives pool shares."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "provider",
          "signer": true
        },
        {
          "name": "pool"
        },
        {
          "name": "mint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "poolVault",
          "writable": true
        },
        {
          "name": "providerToken",
          "writable": true
        },
        {
          "name": "providerShares",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "faucet",
      "docs": [
        "Devnet helper: mints test stablecoins from a mint whose authority is",
        "this program's faucet PDA. Worthless by construction on any cluster."
      ],
      "discriminator": [
        0,
        98,
        59,
        30,
        144,
        142,
        113,
        12
      ],
      "accounts": [
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "faucetAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  97,
                  117,
                  99,
                  101,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "recipientToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initPool",
      "docs": [
        "Creates a liquidity pool for one stablecoin mint."
      ],
      "discriminator": [
        116,
        233,
        199,
        204,
        115,
        159,
        171,
        36
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "poolVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "advanceFeeBps",
          "type": "u16"
        },
        {
          "name": "maxAdvanceBps",
          "type": "u16"
        },
        {
          "name": "arbiter",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "markShipped",
      "docs": [
        "Supplier records proof of shipment (hash of the bill of lading or",
        "tracking record). Starts the importer's inspection window."
      ],
      "discriminator": [
        239,
        5,
        66,
        105,
        238,
        17,
        89,
        97
      ],
      "accounts": [
        {
          "name": "supplier",
          "signer": true,
          "relations": [
            "deal"
          ]
        },
        {
          "name": "deal",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "shipmentHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "openDispute",
      "docs": [
        "Importer disputes the shipment inside the inspection window."
      ],
      "discriminator": [
        137,
        25,
        99,
        119,
        23,
        223,
        161,
        42
      ],
      "accounts": [
        {
          "name": "importer",
          "signer": true,
          "relations": [
            "deal"
          ]
        },
        {
          "name": "deal",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "refundUnshipped",
      "docs": [
        "Importer takes the money back if the supplier never shipped in time."
      ],
      "discriminator": [
        68,
        79,
        132,
        124,
        3,
        87,
        233,
        201
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "deal",
          "writable": true
        },
        {
          "name": "pool",
          "writable": true,
          "relations": [
            "deal"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "deal",
            "pool"
          ]
        },
        {
          "name": "dealVault",
          "writable": true
        },
        {
          "name": "poolVault",
          "writable": true
        },
        {
          "name": "supplierToken",
          "writable": true
        },
        {
          "name": "importerToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "requestAdvance",
      "docs": [
        "Supplier draws an advance from the pool against the locked escrow."
      ],
      "discriminator": [
        30,
        94,
        222,
        131,
        223,
        83,
        0,
        28
      ],
      "accounts": [
        {
          "name": "supplier",
          "signer": true,
          "relations": [
            "deal"
          ]
        },
        {
          "name": "deal",
          "writable": true
        },
        {
          "name": "pool",
          "writable": true,
          "relations": [
            "deal"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "deal",
            "pool"
          ]
        },
        {
          "name": "poolVault",
          "writable": true
        },
        {
          "name": "supplierToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "resolveDispute",
      "docs": [
        "The pool's arbiter splits the escrow. The supplier's share repays the",
        "pool first; any shortfall is booked as a pool loss."
      ],
      "discriminator": [
        231,
        6,
        202,
        6,
        96,
        103,
        12,
        230
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "deal",
          "writable": true
        },
        {
          "name": "pool",
          "writable": true,
          "relations": [
            "deal"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "deal",
            "pool"
          ]
        },
        {
          "name": "dealVault",
          "writable": true
        },
        {
          "name": "poolVault",
          "writable": true
        },
        {
          "name": "supplierToken",
          "writable": true
        },
        {
          "name": "importerToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "supplierBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "withdraw",
      "docs": [
        "Liquidity provider burns shares for their pro-rata stablecoins.",
        "Only idle liquidity can leave; capital lent out stays until repaid."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "provider",
          "signer": true
        },
        {
          "name": "pool"
        },
        {
          "name": "mint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "poolVault",
          "writable": true
        },
        {
          "name": "providerToken",
          "writable": true
        },
        {
          "name": "providerShares",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "deal",
      "discriminator": [
        125,
        223,
        160,
        234,
        71,
        162,
        182,
        219
      ]
    },
    {
      "name": "pool",
      "discriminator": [
        241,
        154,
        109,
        4,
        17,
        177,
        109,
        188
      ]
    }
  ],
  "events": [
    {
      "name": "advancePaid",
      "discriminator": [
        250,
        72,
        166,
        185,
        3,
        194,
        18,
        41
      ]
    },
    {
      "name": "dealCreated",
      "discriminator": [
        27,
        18,
        50,
        52,
        104,
        175,
        46,
        101
      ]
    },
    {
      "name": "dealDisputed",
      "discriminator": [
        232,
        107,
        140,
        245,
        64,
        71,
        20,
        223
      ]
    },
    {
      "name": "dealSettled",
      "discriminator": [
        41,
        213,
        235,
        64,
        55,
        168,
        51,
        76
      ]
    },
    {
      "name": "dealShipped",
      "discriminator": [
        244,
        176,
        78,
        233,
        48,
        78,
        56,
        195
      ]
    },
    {
      "name": "liquidityDeposited",
      "discriminator": [
        218,
        155,
        74,
        193,
        59,
        66,
        94,
        122
      ]
    },
    {
      "name": "liquidityWithdrawn",
      "discriminator": [
        240,
        120,
        73,
        139,
        154,
        31,
        218,
        68
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6001,
      "name": "invalidBps",
      "msg": "Basis points out of range"
    },
    {
      "code": 6002,
      "name": "invalidDeadline",
      "msg": "Deadline or window out of range"
    },
    {
      "code": 6003,
      "name": "sameParty",
      "msg": "Importer and supplier must be different wallets"
    },
    {
      "code": 6004,
      "name": "unauthorized",
      "msg": "Signer is not allowed to perform this action"
    },
    {
      "code": 6005,
      "name": "invalidState",
      "msg": "Deal is not in the right state for this action"
    },
    {
      "code": 6006,
      "name": "shipDeadlinePassed",
      "msg": "Shipping deadline has passed"
    },
    {
      "code": 6007,
      "name": "shipDeadlineNotReached",
      "msg": "Shipping deadline has not passed yet"
    },
    {
      "code": 6008,
      "name": "missingProof",
      "msg": "Proof of shipment is required"
    },
    {
      "code": 6009,
      "name": "advanceAlreadyTaken",
      "msg": "An advance was already drawn on this deal"
    },
    {
      "code": 6010,
      "name": "advanceTooLarge",
      "msg": "Requested amount is above the allowed limit"
    },
    {
      "code": 6011,
      "name": "insufficientLiquidity",
      "msg": "Not enough idle liquidity in the pool"
    },
    {
      "code": 6012,
      "name": "windowClosed",
      "msg": "Inspection window is closed"
    },
    {
      "code": 6013,
      "name": "windowStillOpen",
      "msg": "Inspection window is still open"
    },
    {
      "code": 6014,
      "name": "mathOverflow",
      "msg": "Math overflow"
    }
  ],
  "types": [
    {
      "name": "advancePaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "deal",
            "type": "pubkey"
          },
          {
            "name": "supplier",
            "type": "pubkey"
          },
          {
            "name": "principal",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "deal",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "importer",
            "type": "pubkey"
          },
          {
            "name": "supplier",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "dealId",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "termsHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "shipmentHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "shipBy",
            "type": "i64"
          },
          {
            "name": "releaseWindow",
            "type": "i64"
          },
          {
            "name": "shippedAt",
            "type": "i64"
          },
          {
            "name": "advancePrincipal",
            "type": "u64"
          },
          {
            "name": "advanceFee",
            "type": "u64"
          },
          {
            "name": "poolRepaid",
            "type": "u64"
          },
          {
            "name": "supplierPaid",
            "type": "u64"
          },
          {
            "name": "importerRefunded",
            "type": "u64"
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "dealState"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "dealCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "deal",
            "type": "pubkey"
          },
          {
            "name": "importer",
            "type": "pubkey"
          },
          {
            "name": "supplier",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shipBy",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "dealDisputed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "deal",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "dealSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "deal",
            "type": "pubkey"
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "dealState"
              }
            }
          },
          {
            "name": "toPool",
            "type": "u64"
          },
          {
            "name": "toSupplier",
            "type": "u64"
          },
          {
            "name": "toImporter",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "dealShipped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "deal",
            "type": "pubkey"
          },
          {
            "name": "shipmentHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "releaseAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "dealState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "funded"
          },
          {
            "name": "shipped"
          },
          {
            "name": "disputed"
          },
          {
            "name": "released"
          },
          {
            "name": "resolved"
          },
          {
            "name": "refunded"
          }
        ]
      }
    },
    {
      "name": "liquidityDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "liquidityWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "pool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "arbiter",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "shareMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "advanceFeeBps",
            "type": "u16"
          },
          {
            "name": "maxAdvanceBps",
            "type": "u16"
          },
          {
            "name": "outstandingPrincipal",
            "type": "u64"
          },
          {
            "name": "feesEarned",
            "type": "u64"
          },
          {
            "name": "losses",
            "type": "u64"
          },
          {
            "name": "advancesPaid",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
