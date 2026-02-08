import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { AsyncBuildersAnchorAmm } from "../target/types/async_builders_anchor_amm";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert } from "chai";

describe("async_builders_anchor_amm", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .AsyncBuildersAnchorAmm as Program<AsyncBuildersAnchorAmm>;

  // Test accounts
  let mintX: PublicKey;
  let mintY: PublicKey;
  let mintLp: PublicKey;
  let userX: PublicKey;
  let userY: PublicKey;
  let userLp: PublicKey;
  let vaultX: PublicKey;
  let vaultY: PublicKey;
  let config: PublicKey;

  const seed = new BN(Math.floor(Math.random() * 1000000));
  const fee = 300; // 3% fee in basis points (300/10000 = 0.03)
  const user = provider.wallet;

  before(async () => {
    // Create token mints for X and Y
    mintX = await createMint(
      provider.connection,
      user.payer,
      user.publicKey,
      null,
      6,
    );

    mintY = await createMint(
      provider.connection,
      user.payer,
      user.publicKey,
      null,
      6,
    );

    console.log("Mint X:", mintX.toString());
    console.log("Mint Y:", mintY.toString());

    // Derive PDAs
    [config] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), seed.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );

    [mintLp] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), config.toBuffer()],
      program.programId,
    );

    // Derive vault ATA addresses (program will create them via init)
    vaultX = getAssociatedTokenAddressSync(mintX, config, true);
    vaultY = getAssociatedTokenAddressSync(mintY, config, true);

    console.log("Config PDA:", config.toString());
    console.log("LP Mint PDA:", mintLp.toString());

    // Create user token accounts and mint tokens (needed for deposit/swap/withdraw)
    const userXAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user.payer,
      mintX,
      user.publicKey,
    );
    userX = userXAccount.address;

    const userYAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user.payer,
      mintY,
      user.publicKey,
    );
    userY = userYAccount.address;

    // Mint tokens to user
    const amountToMint = 1_000_000_000;
    await mintTo(
      provider.connection,
      user.payer,
      mintX,
      userX,
      user.publicKey,
      amountToMint,
    );
    await mintTo(
      provider.connection,
      user.payer,
      mintY,
      userY,
      user.publicKey,
      amountToMint,
    );
    console.log("Minted 1000 tokens of X and Y to user");
  });

  it("Initialize pool", async () => {
    // Initialize the pool - program creates config, mintLp, vaultX, vaultY
    const tx = await program.methods
      .initialize(seed, fee, null)
      .accountsPartial({
        initializer: user.publicKey,
        mintX: mintX,
        mintY: mintY,
        mintLp: mintLp,
        vaultX: vaultX,
        vaultY: vaultY,
        config: config,
      })
      .rpc();

    console.log("Initialize transaction signature:", tx);

    // Verify the config account was created with correct values
    const configAccount = await program.account.config.fetch(config);
    assert.equal(configAccount.seed.toString(), seed.toString());
    assert.equal(configAccount.fee, fee);
    assert.equal(configAccount.mintX.toString(), mintX.toString());
    assert.equal(configAccount.mintY.toString(), mintY.toString());
    assert.equal(configAccount.locked, false);

    console.log("✓ Pool initialized successfully");
    console.log("  Seed:", configAccount.seed.toString());
    console.log("  Fee:", configAccount.fee, "basis points");
  });

  it("Deposit liquidity to pool", async () => {
    // Deposit liquidity
    const depositAmount = new BN(100_000_000);
    const maxX = new BN(500_000_000);
    const maxY = new BN(500_000_000);

    const tx = await program.methods
      .deposit(depositAmount, maxX, maxY)
      .accountsPartial({
        user: user.publicKey,
        mintX: mintX,
        mintY: mintY,
        config: config,
        mintLp: mintLp,
        vaultX: vaultX,
        vaultY: vaultY,
        userX: userX,
        userY: userY,
      })
      .rpc();

    console.log("Deposit transaction signature:", tx);

    // Verify balances
    const vaultXAccountInfo = await getAccount(provider.connection, vaultX);
    const vaultYAccountInfo = await getAccount(provider.connection, vaultY);
    const userXAccountInfo = await getAccount(provider.connection, userX);
    const userYAccountInfo = await getAccount(provider.connection, userY);

    console.log("✓ Deposit successful");
    console.log("  Vault X balance:", vaultXAccountInfo.amount.toString());
    console.log("  Vault Y balance:", vaultYAccountInfo.amount.toString());
    console.log("  User X balance:", userXAccountInfo.amount.toString());
    console.log("  User Y balance:", userYAccountInfo.amount.toString());

    assert.ok(
      vaultXAccountInfo.amount > BigInt(0),
      "Vault X should have tokens",
    );
    assert.ok(
      vaultYAccountInfo.amount > BigInt(0),
      "Vault Y should have tokens",
    );
  });

  it("Swap tokens in pool", async () => {
    // Get initial balances
    const userXBefore = await getAccount(provider.connection, userX);
    const userYBefore = await getAccount(provider.connection, userY);
    const vaultXBefore = await getAccount(provider.connection, vaultX);
    const vaultYBefore = await getAccount(provider.connection, vaultY);

    console.log("Before swap:");
    console.log("  User X:", userXBefore.amount.toString());
    console.log("  User Y:", userYBefore.amount.toString());
    console.log("  Vault X:", vaultXBefore.amount.toString());
    console.log("  Vault Y:", vaultYBefore.amount.toString());

    // Swap X for Y
    const swapAmount = new BN(10_000_000);
    const minOut = new BN(1);

    const tx = await program.methods
      .swap(true, swapAmount, minOut)
      .accountsPartial({
        user: user.publicKey,
        mintX: mintX,
        mintY: mintY,
        config: config,
        vaultX: vaultX,
        vaultY: vaultY,
        userX: userX,
        userY: userY,
      })
      .rpc();

    console.log("Swap transaction signature:", tx);

    // Get final balances
    const userXAfter = await getAccount(provider.connection, userX);
    const userYAfter = await getAccount(provider.connection, userY);
    const vaultXAfter = await getAccount(provider.connection, vaultX);
    const vaultYAfter = await getAccount(provider.connection, vaultY);

    console.log("After swap:");
    console.log("  User X:", userXAfter.amount.toString());
    console.log("  User Y:", userYAfter.amount.toString());
    console.log("  Vault X:", vaultXAfter.amount.toString());
    console.log("  Vault Y:", vaultYAfter.amount.toString());

    // Verify swap happened
    assert.ok(
      userXAfter.amount < userXBefore.amount,
      "User X balance should decrease",
    );
    assert.ok(
      userYAfter.amount > userYBefore.amount,
      "User Y balance should increase",
    );
    assert.ok(
      vaultXAfter.amount > vaultXBefore.amount,
      "Vault X balance should increase",
    );
    assert.ok(
      vaultYAfter.amount < vaultYBefore.amount,
      "Vault Y balance should decrease",
    );

    console.log("✓ Swap successful");
    console.log(
      "  Swapped X for Y - received",
      (userYAfter.amount - userYBefore.amount).toString(),
      "Y tokens",
    );
  });

  it("Withdraw liquidity from pool", async () => {
    // Get user LP token account
    const userLpAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user.payer,
      mintLp,
      user.publicKey,
    );
    userLp = userLpAccount.address;

    const lpBalance = await getAccount(provider.connection, userLp);
    console.log("User LP balance:", lpBalance.amount.toString());

    // Get initial balances
    const userXBefore = await getAccount(provider.connection, userX);
    const userYBefore = await getAccount(provider.connection, userY);

    // Withdraw half of LP tokens
    const withdrawAmount = new BN(lpBalance.amount.toString()).div(new BN(2));
    const minX = new BN(1);
    const minY = new BN(1);

    const tx = await program.methods
      .withdraw(withdrawAmount, minX, minY)
      .accountsPartial({
        user: user.publicKey,
        mintX: mintX,
        mintY: mintY,
        config: config,
        mintLp: mintLp,
        vaultX: vaultX,
        vaultY: vaultY,
        userX: userX,
        userY: userY,
        userLp: userLp,
      })
      .rpc();

    console.log("Withdraw transaction signature:", tx);

    // Get final balances
    const userXAfter = await getAccount(provider.connection, userX);
    const userYAfter = await getAccount(provider.connection, userY);
    const lpBalanceAfter = await getAccount(provider.connection, userLp);

    console.log("✓ Withdraw successful");
    console.log(
      "  Received X tokens:",
      (userXAfter.amount - userXBefore.amount).toString(),
    );
    console.log(
      "  Received Y tokens:",
      (userYAfter.amount - userYBefore.amount).toString(),
    );
    console.log("  LP tokens burned:", withdrawAmount.toString());
    console.log("  Remaining LP balance:", lpBalanceAfter.amount.toString());

    assert.ok(
      userXAfter.amount > userXBefore.amount,
      "User should receive X tokens",
    );
    assert.ok(
      userYAfter.amount > userYBefore.amount,
      "User should receive Y tokens",
    );
    assert.ok(
      lpBalanceAfter.amount < lpBalance.amount,
      "LP tokens should be burned",
    );
  });
});
