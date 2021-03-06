require('.'); // import common test scaffolding

const ProxyERC20 = artifacts.require('ProxyERC20');
const Oikos = artifacts.require('Oikos');
const TokenExchanger = artifacts.require('TokenExchanger');

const { toUnit } = require('../utils/testUtils');

contract('ProxyERC20', async accounts => {
	const [deployerAccount, owner, account1, account2, account3] = accounts;

	let oikos, proxyERC20, tokenExchanger;

	beforeEach(async () => {
		proxyERC20 = await ProxyERC20.new(owner, { from: deployerAccount });
		oikos = await Oikos.deployed();
		await oikos.setIntegrationProxy(proxyERC20.address, { from: owner });
		await proxyERC20.setTarget(oikos.address, { from: owner });

		// Deploy an on chain exchanger
		tokenExchanger = await TokenExchanger.new(owner, proxyERC20.address, {
			from: deployerAccount,
		});

		// Give some SNX to account1 and account2
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});
		await oikos.transfer(account2, toUnit('10000'), {
			from: owner,
		});

		// Issue 10 oUSD each
		await oikos.issueSynths(toUnit('10'), { from: account1 });
		await oikos.issueSynths(toUnit('10'), { from: account2 });
	});

	it('should setIntegrationProxy on oikos on deployment', async () => {
		const _integrationProxyAddress = await oikos.integrationProxy();
		assert.equal(proxyERC20.address, _integrationProxyAddress);
	});

	it('should setTarget on ProxyERC20 to oikos on deployment', async () => {
		const integrationProxyTarget = await proxyERC20.target();
		assert.equal(oikos.address, integrationProxyTarget);
	});

	it('should tokenExchanger has ProxyERC20 set on deployment', async () => {
		const _integrationProxyAddress = await tokenExchanger.integrationProxy();
		assert.equal(proxyERC20.address, _integrationProxyAddress);
	});

	describe('ProxyERC20 should adhere to ERC20 standard', async () => {
		it('should be able to query ERC20 totalSupply', async () => {
			// Get SNX totalSupply
			const snxTotalSupply = await oikos.totalSupply();
			const proxyTotalSupply = await proxyERC20.totalSupply();
			assert.bnEqual(snxTotalSupply, proxyTotalSupply);
		});

		it('should be able to query ERC20 balanceOf', async () => {
			// Get my SNX balance
			const mySNXBalance = await oikos.balanceOf(account1);
			const myProxyBalance = await proxyERC20.balanceOf(account1);
			assert.bnEqual(myProxyBalance, mySNXBalance);
		});

		it('should be able to call ERC20 approve', async () => {
			const amountToTransfer = toUnit('50');

			// Approve Account2 to spend 50
			const approveTX = await proxyERC20.approve(account2, amountToTransfer, {
				from: account1,
			});
			// Check for Approval event
			assert.eventEqual(approveTX, 'Approval', {
				owner: account1,
				spender: account2,
				value: amountToTransfer,
			});
			// should be able to query ERC20 allowance
			const allowance = await proxyERC20.allowance(account1, account2);

			// Assert we have the same
			assert.bnEqual(allowance, amountToTransfer);
		});

		it('should be able to call ERC20 transferFrom', async () => {
			const amountToTransfer = toUnit('33');

			// Approve Account2 to spend 50
			await proxyERC20.approve(account2, amountToTransfer, { from: account1 });

			// Get Before Transfer Balances
			const account1BalanceBefore = await oikos.balanceOf(account1);
			const account3BalanceBefore = await oikos.balanceOf(account3);

			// Transfer SNX
			const transferTX = await oikos.transferFrom(account1, account3, amountToTransfer, {
				from: account2,
			});

			// Check for Transfer event
			assert.eventEqual(transferTX, 'Transfer', {
				from: account1,
				to: account3,
				value: amountToTransfer,
			});

			// Get After Transfer Balances
			const account1BalanceAfter = await oikos.balanceOf(account1);
			const account3BalanceAfter = await oikos.balanceOf(account3);

			// Check Balances
			assert.bnEqual(account1BalanceBefore.sub(amountToTransfer), account1BalanceAfter);
			assert.bnEqual(account3BalanceBefore.add(amountToTransfer), account3BalanceAfter);
		});

		it('should be able to call ERC20 transfer', async () => {
			const amountToTransfer = toUnit('44');

			// Get Before Transfer Balances
			const account1BalanceBefore = await oikos.balanceOf(account1);
			const account2BalanceBefore = await oikos.balanceOf(account2);

			const transferTX = await oikos.transfer(account2, amountToTransfer, {
				from: account1,
			});

			// Check for Transfer event
			assert.eventEqual(transferTX, 'Transfer', {
				from: account1,
				to: account2,
				value: amountToTransfer,
			});

			// Get After Transfer Balances
			const account1BalanceAfter = await oikos.balanceOf(account1);
			const account2BalanceAfter = await oikos.balanceOf(account2);

			// Check Balances
			assert.bnEqual(account1BalanceBefore.sub(amountToTransfer), account1BalanceAfter);
			assert.bnEqual(account2BalanceBefore.add(amountToTransfer), account2BalanceAfter);
		});
	});

	describe('third party contracts', async () => {
		it('should be able to query ERC20 balanceOf', async () => {
			// Get account1 SNX balance direct
			const mySNXBalance = await oikos.balanceOf(account1);
			// Get account1 SNX balance via ERC20 Proxy
			const myProxyBalance = await tokenExchanger.checkBalance(account1);
			// Assert Balance with no reverts
			assert.bnEqual(myProxyBalance, mySNXBalance);
		});

		it('should be able to transferFrom ERC20', async () => {
			const amountToTransfer = toUnit('77');

			// Approve tokenExchanger to spend account1 balance
			const approveTX = await proxyERC20.approve(tokenExchanger.address, amountToTransfer, {
				from: account1,
			});

			// Check for Approval event
			assert.eventEqual(approveTX, 'Approval', {
				owner: account1,
				spender: tokenExchanger.address,
				value: amountToTransfer,
			});

			// should be able to query ERC20 allowance
			const allowance = await proxyERC20.allowance(account1, tokenExchanger.address);

			// Assert we have the allowance
			assert.bnEqual(allowance, amountToTransfer);

			// Get Before Transfer Balances
			const account1BalanceBefore = await oikos.balanceOf(account1);
			const account2BalanceBefore = await oikos.balanceOf(account2);

			// tokenExchanger to transfer Account1's SNX to Account2
			await tokenExchanger.doTokenSpend(account1, account2, amountToTransfer);

			// Get After Transfer Balances
			const account1BalanceAfter = await oikos.balanceOf(account1);
			const account2BalanceAfter = await oikos.balanceOf(account2);

			// Check Balances
			assert.bnEqual(account1BalanceBefore.sub(amountToTransfer), account1BalanceAfter);
			assert.bnEqual(account2BalanceBefore.add(amountToTransfer), account2BalanceAfter);
		});

		it('should be able to query optional ERC20 decimals', async () => {
			// Get decimals
			const snxDecimals = await oikos.decimals();
			const snxDecimalsContract = await tokenExchanger.getDecimals(oikos.address);
			assert.bnEqual(snxDecimals, snxDecimalsContract);
		});
	});
});
