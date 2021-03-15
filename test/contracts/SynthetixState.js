require('.'); // import common test scaffolding

const Oikos = artifacts.require('Oikos');
const OikosState = artifacts.require('OikosState');
const Synth = artifacts.require('Synth');
const Issuer = artifacts.require('Issuer');

const { toUnit } = require('../utils/testUtils');
const { toBytes32 } = require('../..');

contract('OikosState', async accounts => {
	const oUSD = toBytes32('oUSD');

	const [deployerAccount, owner, account1, account2] = accounts;

	let oikos, oikosState, sUSDContract, issuer;

	beforeEach(async () => {
		// Save ourselves from having to await deployed() in every single test.
		// We do this in a beforeEach instead of before to ensure we isolate
		// contract interfaces to prevent test bleed.
		oikos = await Oikos.deployed();
		oikosState = await OikosState.deployed();
		issuer = await Issuer.deployed();
		sUSDContract = await Synth.at(await oikos.synths(oUSD));

		// set minimumStakeTime on issue and burning to 0
		await issuer.setMinimumStakeTime(0, { from: owner });
	});

	it('should set constructor params on deployment', async () => {
		// constructor(address _owner, address _associatedContract)
		const instance = await OikosState.new(account1, account2, {
			from: deployerAccount,
		});

		assert.equal(await instance.owner(), account1);
		assert.equal(await instance.associatedContract(), account2);
	});

	it('should allow the owner to set the issuance ratio', async () => {
		const ratio = toUnit('0.2');

		const transaction = await oikosState.setIssuanceRatio(ratio, {
			from: owner,
		});

		assert.eventEqual(transaction, 'IssuanceRatioUpdated', { newRatio: ratio });
	});

	it('should allow the owner to set the issuance ratio to zero', async () => {
		const ratio = web3.utils.toBN('0');

		const transaction = await oikosState.setIssuanceRatio(ratio, {
			from: owner,
		});

		assert.eventEqual(transaction, 'IssuanceRatioUpdated', { newRatio: ratio });
	});

	it('should disallow a non-owner from setting the issuance ratio', async () => {
		const ratio = toUnit('0.2');

		await assert.revert(
			oikosState.setIssuanceRatio(ratio, {
				from: account1,
			})
		);
	});

	it('should disallow setting the issuance ratio above the MAX ratio', async () => {
		const max = toUnit('1');

		// It should succeed when setting it to max
		const transaction = await oikosState.setIssuanceRatio(max, {
			from: owner,
		});
		assert.eventEqual(transaction, 'IssuanceRatioUpdated', { newRatio: max });

		// But max + 1 should fail
		await assert.revert(
			oikosState.setIssuanceRatio(web3.utils.toBN(max).add(web3.utils.toBN('1')), {
				from: account1,
			})
		);
	});

	it('should allow the associated contract to setCurrentIssuanceData', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });
		await oikosState.setCurrentIssuanceData(account2, toUnit('0.1'), { from: account1 });
	});

	it('should disallow another address from calling setCurrentIssuanceData', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });
		await assert.revert(
			oikosState.setCurrentIssuanceData(account2, toUnit('0.1'), { from: account2 })
		);
	});

	it('should allow the associated contract to clearIssuanceData', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });
		await oikosState.setCurrentIssuanceData(account2, toUnit('0.1'), { from: account1 });
		await oikosState.clearIssuanceData(account2, { from: account1 });
		assert.bnEqual((await oikosState.issuanceData(account2)).initialDebtOwnership, 0);
	});

	it('should disallow another address from calling clearIssuanceData', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });
		await assert.revert(oikosState.clearIssuanceData(account2, { from: account2 }));
	});

	it('should allow the associated contract to incrementTotalIssuerCount', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });

		await oikosState.incrementTotalIssuerCount({ from: account1 });
		assert.bnEqual(await oikosState.totalIssuerCount(), 1);
	});

	it('should disallow another address from calling incrementTotalIssuerCount', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });
		await assert.revert(oikosState.incrementTotalIssuerCount({ from: account2 }));
	});

	it('should allow the associated contract to decrementTotalIssuerCount', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });

		// We need to increment first or we'll overflow on subtracting from zero and revert that way
		await oikosState.incrementTotalIssuerCount({ from: account1 });
		await oikosState.decrementTotalIssuerCount({ from: account1 });
		assert.bnEqual(await oikosState.totalIssuerCount(), 0);
	});

	it('should disallow another address from calling decrementTotalIssuerCount', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });

		// We need to increment first or we'll overflow on subtracting from zero and revert that way
		await oikosState.incrementTotalIssuerCount({ from: account1 });
		await assert.revert(oikosState.decrementTotalIssuerCount({ from: account2 }));
	});

	it('should allow the associated contract to appendDebtLedgerValue', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });

		await oikosState.appendDebtLedgerValue(toUnit('0.1'), { from: account1 });
		assert.bnEqual(await oikosState.lastDebtLedgerEntry(), toUnit('0.1'));
	});

	it('should disallow another address from calling appendDebtLedgerValue', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });

		await assert.revert(oikosState.appendDebtLedgerValue(toUnit('0.1'), { from: account2 }));
	});

	it('should correctly report debtLedgerLength', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });

		assert.bnEqual(await oikosState.debtLedgerLength(), 0);
		await oikosState.appendDebtLedgerValue(toUnit('0.1'), { from: account1 });
		assert.bnEqual(await oikosState.debtLedgerLength(), 1);
	});

	it('should correctly report lastDebtLedgerEntry', async () => {
		await oikosState.setAssociatedContract(account1, { from: owner });

		// Nothing in the array, so we should revert on invalid opcode
		await assert.invalidOpcode(oikosState.lastDebtLedgerEntry());
		await oikosState.appendDebtLedgerValue(toUnit('0.1'), { from: account1 });
		assert.bnEqual(await oikosState.lastDebtLedgerEntry(), toUnit('0.1'));
	});

	it('should correctly report hasIssued for an address', async () => {
		assert.equal(await oikosState.hasIssued(owner), false);

		await oikos.issueMaxSynths({ from: owner });
		const synthBalance = await sUSDContract.balanceOf(owner);

		assert.equal(await oikosState.hasIssued(owner), true);

		await oikos.burnSynths(synthBalance, { from: owner });

		assert.equal(await oikosState.hasIssued(owner), false);
	});
});
