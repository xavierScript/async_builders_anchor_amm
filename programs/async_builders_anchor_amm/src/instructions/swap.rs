use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer, Mint, Token, TokenAccount, Transfer},
};
use constant_product_curve::{ConstantProduct, LiquidityPair};

use crate::{errors::AmmError, state::Config};

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub mint_x: Account<'info, Mint>,

    pub mint_y: Account<'info, Mint>,

    #[account(
        has_one = mint_x,
        has_one = mint_y,
        seeds = [b"config", config.seed.to_le_bytes().as_ref()],
        bump = config.config_bump,
    )]
    pub config: Account<'info, Config>,

      #[account(
        mut,
        associated_token::mint = mint_x,
        associated_token::authority = config,
    )]
    pub vault_x: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_y,
        associated_token::authority = config,
    )]
    pub vault_y: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_x,
        associated_token::authority = user,
    )]
    pub user_x: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_y,
        associated_token::authority = user,
    )]
    pub user_y: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> Swap<'info> {
    pub fn swap(&mut self, is_x: bool, amount: u64, min: u64) -> Result<()> {
        require!(self.config.locked == false, AmmError::PoolLocked);
        require!(amount != 0, AmmError::InvalidAmount);

        // Convert boolean to LiquidityPair enum
        let pair = if is_x {
            LiquidityPair::X
        } else {
            LiquidityPair::Y
        };

        // Calculate amount after fee deduction
        let amount_after_fee = (amount as u128)
            .checked_mul((10_000 - self.config.fee) as u128)
            .ok_or(AmmError::Overflow)?
            .checked_div(10_000)
            .ok_or(AmmError::Overflow)? as u64;

        // Calculate output amount based on constant product formula
        // If depositing X, we receive Y; if depositing Y, we receive X
        let output = match pair {
            LiquidityPair::X => {
                // Depositing X, receiving Y
                ConstantProduct::delta_y_from_x_swap_amount(
                    self.vault_x.amount,
                    self.vault_y.amount,
                    amount_after_fee,
                )
                .map_err(|_| AmmError::CurveError)?
            }
            LiquidityPair::Y => {
                // Depositing Y, receiving X
                ConstantProduct::delta_x_from_y_swap_amount(
                    self.vault_x.amount,
                    self.vault_y.amount,
                    amount_after_fee,
                )
                .map_err(|_| AmmError::CurveError)?
            }
        };

        // Check slippage protection
        require!(output >= min, AmmError::SlippageExceeded);

        // Deposit input tokens from user to vault
        self.deposit_tokens(&pair, amount)?;
        // Withdraw output tokens from vault to user
        self.withdraw_tokens_opposite(&pair, output)
    }

    pub fn deposit_tokens(&self, pair: &LiquidityPair, amount: u64) -> Result<()> {
        let (from, to) = match pair {
            LiquidityPair::X => (
                self.user_x.to_account_info(),
                self.vault_x.to_account_info(),
            ),
            LiquidityPair::Y => (
                self.user_y.to_account_info(),
                self.vault_y.to_account_info(),
            ),
        };

        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = Transfer {
            from,
            to,
            authority: self.user.to_account_info(),
        };

        let ctx = CpiContext::new(cpi_program, cpi_accounts);

        transfer(ctx, amount)
    }

    pub fn withdraw_tokens_opposite(&self, pair: &LiquidityPair, amount: u64) -> Result<()> {
        let (from, to) = match pair {
            LiquidityPair::X => (
                self.vault_y.to_account_info(),
                self.user_y.to_account_info(),
            ),
            LiquidityPair::Y => (
                self.vault_x.to_account_info(),
                self.user_x.to_account_info(),
            ),
        };

        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = Transfer {
            from,
            to,
            authority: self.config.to_account_info(),
        };

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"config",
            &self.config.seed.to_le_bytes(),
            &[self.config.config_bump],
        ]];

        let ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        transfer(ctx, amount)
    }
}