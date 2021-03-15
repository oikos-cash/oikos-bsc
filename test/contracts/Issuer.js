require('.'); // import common test scaffolding

const ExchangeRates = artifacts.require('ExchangeRates');
const Escrow = artifacts.require('OikosEscrow');
const RewardEscrow = artifacts.require('RewardEscrow');
const Issuer = artifacts.require('Issuer');
const FeePool = artifacts.require('FeePool');
const Oikos = artifacts.require('Oikos');
const OikosState = artifacts.require('OikosState');
const Synth = artifacts.require('Synth');

const {
	currentTime,
	multiplyDecimal,
	divideDecimal,
	toUnit,
	fastForward,
} = require('../utils/testUtils');

const {
	setExchangeWaitingPeriod,
	setExchangeFee,
	getDecodedLogs,
	decodedEventEqual,
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	updateRatesWithDefaults,
} = require('../utils/setupUtils');

const { toBytes32 } = require('../..');

contract('Issuer (via Oikos)', async accounts => {
	const [oUSD, sAUD, sEUR, SNX] = ['oUSD', 'sAUD', 'sEUR', 'SNX'].map(toBytes32);

	const [, owner, account1, account2, account3, account6] = accounts;

	let oikos,
		oikosState,
		exchangeRates,
		feePool,
		sUSDContract,
		escrow,
		rewardEscrow,
		oracle,
		timestamp,
		issuer;

	const getRemainingIssuableSynths = async account =>
		(await oikos.remainingIssuableSynths(account))[0];

	beforeEach(async () => {
		// Save ourselves from having to await deployed() in every single test.
		// We do this in a beforeEach instead of before to ensure we isolate
		// contract interfaces to prevent test bleed.
		exchangeRates = await ExchangeRates.deployed();
		feePool = await FeePool.deployed();
		escrow = await Escrow.deployed();
		rewardEscrow = await RewardEscrow.deployed();

		oikos = await Oikos.deployed();
		oikosState = await OikosState.deployed();
		sUSDContract = await Synth.at(await oikos.synths(oUSD));
		issuer = await Issuer.deployed();
		oracle = await exchangeRates.oracle();
		timestamp = await currentTime();

		// set minimumStakeTime on issue and burning to 0
		await issuer.setMinimumStakeTime(0, { from: owner });
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: issuer.abi,
			ignoreParents: ['MixinResolver'],
			expected: [
				'issueSynths',
				'issueMaxSynths',
				'burnSynths',
				'burnSynthsToTarget',
				'setMinimumStakeTime',
			],
		});
	});

	describe('protected methods', () => {
		it('issueSynths() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueSynths,
				args: [account1, toUnit('1')],
				accounts,
				reason: 'Only the oikos contract can perform this action',
			});
		});
		it('issueMaxSynths() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueMaxSynths,
				args: [account1],
				accounts,
				reason: 'Only the oikos contract can perform this action',
			});
		});
		it('burnSynths() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnSynths,
				args: [account1, toUnit('1')],
				accounts,
				reason: 'Only the oikos contract can perform this action',
			});
		});
		it('setMinimumStakeTime() can onlt be invoked by owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.setMinimumStakeTime,
				args: [1],
				address: owner,
				accounts,
				reason: 'Only the contract owner may perform this action',
			});
		});
	});

	describe('minimumStakeTime - recording last issue and burn timestamp', async () => {
		let now;

		beforeEach(async () => {
			// Give some SNX to account1
			await oikos.transfer(account1, toUnit('1000'), { from: owner });

			now = await currentTime();
		});
		it('should revert if setMinimumStakeTime > than 1 week', async () => {
			const week = 604800;

			// revert if setting minimumStakeTime greater than 1 week
			await assert.revert(
				issuer.setMinimumStakeTime(week + 1, { from: owner }),
				'stake time exceed maximum 1 week'
			);
		});
		it('should allow setMinimumStakeTime less than equal 1 week', async () => {
			const week = 604800;

			await issuer.setMinimumStakeTime(week, { from: owner });
		});
		it('should issue synths and store issue timestamp after now', async () => {
			// issue synths
			await oikos.issueSynths(web3.utils.toBN('5'), { from: account1 });

			// issue timestamp should be greater than now in future
			const issueTimestamp = await issuer.lastIssueEvent(owner);
			assert.ok(issueTimestamp.gte(now));
		});

		describe('require wait time on next burn synth after minting', async () => {
			it('should revert when burning any synths within minStakeTime', async () => {
				// set minimumStakeTime
				await issuer.setMinimumStakeTime(60 * 60 * 8, { from: owner });

				// issue synths first
				await oikos.issueSynths(web3.utils.toBN('5'), { from: account1 });

				await assert.revert(
					oikos.burnSynths(web3.utils.toBN('5'), { from: account1 }),
					'Minimum stake time not reached'
				);
			});
			it('should set minStakeTime to 120 seconds and able to burn after wait time', async () => {
				// set minimumStakeTime
				await issuer.setMinimumStakeTime(120, { from: owner });

				// issue synths first
				await oikos.issueSynths(web3.utils.toBN('5'), { from: account1 });

				// fastForward 30 seconds
				await fastForward(10);

				await assert.revert(
					oikos.burnSynths(web3.utils.toBN('5'), { from: account1 }),
					'Minimum stake time not reached'
				);

				// fastForward 115 seconds
				await fastForward(125);

				// burn synths
				await oikos.burnSynths(web3.utils.toBN('5'), { from: account1 });
			});
		});
	});

	// Issuance
	it('should allow the issuance of a small amount of synths', async () => {
		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('1000'), { from: owner });

		// account1 should be able to issue
		// Note: If a too small amount of synths are issued here, the amount may be
		// rounded to 0 in the debt register. This will revert. As such, there is a minimum
		// number of synths that need to be issued each time issue is invoked. The exact
		// amount depends on the Synth exchange rate and the total supply.
		await oikos.issueSynths(web3.utils.toBN('5'), { from: account1 });
	});

	it('should be possible to issue the maximum amount of synths via issueSynths', async () => {
		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('1000'), { from: owner });

		const maxSynths = await oikos.maxIssuableSynths(account1);

		// account1 should be able to issue
		await oikos.issueSynths(maxSynths, { from: account1 });
	});

	it('should allow an issuer to issue synths in one flavour', async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('1000'), { from: owner });

		// account1 should be able to issue
		await oikos.issueSynths(toUnit('10'), { from: account1 });

		// There should be 10 oUSD of value in the system
		assert.bnEqual(await oikos.totalIssuedSynths(oUSD), toUnit('10'));

		// And account1 should own 100% of the debt.
		assert.bnEqual(await oikos.totalIssuedSynths(oUSD), toUnit('10'));
		assert.bnEqual(await oikos.debtBalanceOf(account1, oUSD), toUnit('10'));
	});

	// TODO: Check that the rounding errors are acceptable
	it('should allow two issuers to issue synths in one flavour', async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// Give some SNX to account1 and account2
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});
		await oikos.transfer(account2, toUnit('10000'), {
			from: owner,
		});

		// Issue
		await oikos.issueSynths(toUnit('10'), { from: account1 });
		await oikos.issueSynths(toUnit('20'), { from: account2 });

		// There should be 30sUSD of value in the system
		assert.bnEqual(await oikos.totalIssuedSynths(oUSD), toUnit('30'));

		// And the debt should be split 50/50.
		// But there's a small rounding error.
		// This is ok, as when the last person exits the system, their debt percentage is always 100% so
		// these rounding errors don't cause the system to be out of balance.
		assert.bnClose(await oikos.debtBalanceOf(account1, oUSD), toUnit('10'));
		assert.bnClose(await oikos.debtBalanceOf(account2, oUSD), toUnit('20'));
	});

	it('should allow multi-issuance in one flavour', async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// Give some SNX to account1 and account2
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});
		await oikos.transfer(account2, toUnit('10000'), {
			from: owner,
		});

		// Issue
		await oikos.issueSynths(toUnit('10'), { from: account1 });
		await oikos.issueSynths(toUnit('20'), { from: account2 });
		await oikos.issueSynths(toUnit('10'), { from: account1 });

		// There should be 40 oUSD of value in the system
		assert.bnEqual(await oikos.totalIssuedSynths(oUSD), toUnit('40'));

		// And the debt should be split 50/50.
		// But there's a small rounding error.
		// This is ok, as when the last person exits the system, their debt percentage is always 100% so
		// these rounding errors don't cause the system to be out of balance.
		assert.bnClose(await oikos.debtBalanceOf(account1, oUSD), toUnit('20'));
		assert.bnClose(await oikos.debtBalanceOf(account2, oUSD), toUnit('20'));
	});

	it('should allow an issuer to issue max synths in one flavour', async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});

		// Issue
		await oikos.issueMaxSynths({ from: account1 });

		// There should be 200 oUSD of value in the system
		assert.bnEqual(await oikos.totalIssuedSynths(oUSD), toUnit('200'));

		// And account1 should own all of it.
		assert.bnEqual(await oikos.debtBalanceOf(account1, oUSD), toUnit('200'));
	});

	it('should allow an issuer to issue max synths via the standard issue call', async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});

		// Determine maximum amount that can be issued.
		const maxIssuable = await oikos.maxIssuableSynths(account1);

		// Issue
		await oikos.issueSynths(maxIssuable, { from: account1 });

		// There should be 200 oUSD of value in the system
		assert.bnEqual(await oikos.totalIssuedSynths(oUSD), toUnit('200'));

		// And account1 should own all of it.
		assert.bnEqual(await oikos.debtBalanceOf(account1, oUSD), toUnit('200'));
	});

	it('should disallow an issuer from issuing synths beyond their remainingIssuableSynths', async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});

		// They should now be able to issue oUSD
		const issuableSynths = await getRemainingIssuableSynths(account1);
		assert.bnEqual(issuableSynths, toUnit('200'));

		// Issue that amount.
		await oikos.issueSynths(issuableSynths, { from: account1 });

		// They should now have 0 issuable synths.
		assert.bnEqual(await getRemainingIssuableSynths(account1), '0');

		// And trying to issue the smallest possible unit of one should fail.
		await assert.revert(oikos.issueSynths('1', { from: account1 }));
	});

	it('should allow an issuer with outstanding debt to burn synths and decrease debt', async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});

		// Issue
		await oikos.issueMaxSynths({ from: account1 });

		// account1 should now have 200 oUSD of debt.
		assert.bnEqual(await oikos.debtBalanceOf(account1, oUSD), toUnit('200'));

		// Burn 100 oUSD
		await oikos.burnSynths(toUnit('100'), { from: account1 });

		// account1 should now have 100 oUSD of debt.
		assert.bnEqual(await oikos.debtBalanceOf(account1, oUSD), toUnit('100'));
	});

	it('should disallow an issuer without outstanding debt from burning synths', async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.
		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});

		// Issue
		await oikos.issueMaxSynths({ from: account1 });

		// account2 should not have anything and can't burn.
		await assert.revert(oikos.burnSynths(toUnit('10'), { from: account2 }));

		// And even when we give account2 synths, it should not be able to burn.
		await sUSDContract.transfer(account2, toUnit('100'), {
			from: account1,
		});
		await assert.revert(oikos.burnSynths(toUnit('10'), { from: account2 }));
	});

	it('should burn 0 when trying to burn synths that do not exist', async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});

		// Issue
		await oikos.issueMaxSynths({ from: account1 });

		// Transfer all newly issued synths to account2
		await sUSDContract.transfer(account2, toUnit('200'), {
			from: account1,
		});

		const debtBefore = await oikos.debtBalanceOf(account1, oUSD);
		assert.ok(!debtBefore.isNeg());
		// Burning any amount of oUSD will reduce the amount down to the current supply, which is 0
		await oikos.burnSynths('1', { from: account1 });
		const debtAfter = await oikos.debtBalanceOf(account1, oUSD);
		// So assert their debt balabce is unchanged from the burn of 0
		assert.bnEqual(debtBefore, debtAfter);
	});

	it("should only burn up to a user's actual debt level", async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});
		await oikos.transfer(account2, toUnit('10000'), {
			from: owner,
		});

		// Issue
		const fullAmount = toUnit('210');
		const account1Payment = toUnit('10');
		const account2Payment = fullAmount.sub(account1Payment);
		await oikos.issueSynths(account1Payment, { from: account1 });
		await oikos.issueSynths(account2Payment, { from: account2 });

		// Transfer all of account2's synths to account1
		await sUSDContract.transfer(account1, toUnit('200'), {
			from: account2,
		});
		// return;

		// Calculate the amount that account1 should actually receive
		const amountReceived = await feePool.amountReceivedFromTransfer(toUnit('200'));

		const balanceOfAccount1 = await sUSDContract.balanceOf(account1);

		// Then try to burn them all. Only 10 synths (and fees) should be gone.
		await oikos.burnSynths(balanceOfAccount1, { from: account1 });
		const balanceOfAccount1AfterBurn = await sUSDContract.balanceOf(account1);

		// console.log('##### txn', txn);
		// for (let i = 0; i < txn.logs.length; i++) {
		// 	const result = txn.logs[i].args;
		// 	// console.log('##### txn ???', result);
		// 	for (let j = 0; j < result.__length__; j++) {
		// 		if (txn.logs[i].event === 'SomethingElse' && j === 0) {
		// 			console.log(`##### txn ${i} str`, web3.utils.hexToAscii(txn.logs[i].args[j]));
		// 		} else {
		// 			console.log(`##### txn ${i}`, txn.logs[i].args[j].toString());
		// 		}
		// 	}
		// }

		// Recording debts in the debt ledger reduces accuracy.
		//   Let's allow for a 1000 margin of error.
		assert.bnClose(balanceOfAccount1AfterBurn, amountReceived, '1000');
	});

	it('should correctly calculate debt in a multi-issuance scenario', async () => {
		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('200000'), {
			from: owner,
		});
		await oikos.transfer(account2, toUnit('200000'), {
			from: owner,
		});

		// Issue
		const issuedSynthsPt1 = toUnit('2000');
		const issuedSynthsPt2 = toUnit('2000');
		await oikos.issueSynths(issuedSynthsPt1, { from: account1 });
		await oikos.issueSynths(issuedSynthsPt2, { from: account1 });
		await oikos.issueSynths(toUnit('1000'), { from: account2 });

		const debt = await oikos.debtBalanceOf(account1, oUSD);
		assert.bnClose(debt, toUnit('4000'));
	});

	it('should correctly calculate debt in a multi-issuance multi-burn scenario', async () => {
		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('500000'), {
			from: owner,
		});
		await oikos.transfer(account2, toUnit('14000'), {
			from: owner,
		});

		// Issue
		const issuedSynthsPt1 = toUnit('2000');
		const burntSynthsPt1 = toUnit('1500');
		const issuedSynthsPt2 = toUnit('1600');
		const burntSynthsPt2 = toUnit('500');

		await oikos.issueSynths(issuedSynthsPt1, { from: account1 });
		await oikos.burnSynths(burntSynthsPt1, { from: account1 });
		await oikos.issueSynths(issuedSynthsPt2, { from: account1 });

		await oikos.issueSynths(toUnit('100'), { from: account2 });
		await oikos.issueSynths(toUnit('51'), { from: account2 });
		await oikos.burnSynths(burntSynthsPt2, { from: account1 });

		const debt = await oikos.debtBalanceOf(account1, toBytes32('oUSD'));
		const expectedDebt = issuedSynthsPt1
			.add(issuedSynthsPt2)
			.sub(burntSynthsPt1)
			.sub(burntSynthsPt2);

		assert.bnClose(debt, expectedDebt);
	});

	it("should allow me to burn all synths I've issued when there are other issuers", async () => {
		const totalSupply = await oikos.totalSupply();
		const account2Oikoss = toUnit('120000');
		const account1Oikoss = totalSupply.sub(account2Oikoss);

		await oikos.transfer(account1, account1Oikoss, {
			from: owner,
		}); // Issue the massive majority to account1
		await oikos.transfer(account2, account2Oikoss, {
			from: owner,
		}); // Issue a small amount to account2

		// Issue from account1
		const account1AmountToIssue = await oikos.maxIssuableSynths(account1);
		await oikos.issueMaxSynths({ from: account1 });
		const debtBalance1 = await oikos.debtBalanceOf(account1, oUSD);
		assert.bnClose(debtBalance1, account1AmountToIssue);

		// Issue and burn from account 2 all debt
		await oikos.issueSynths(toUnit('43'), { from: account2 });
		let debt = await oikos.debtBalanceOf(account2, oUSD);
		await oikos.burnSynths(toUnit('43'), { from: account2 });
		debt = await oikos.debtBalanceOf(account2, oUSD);

		assert.bnEqual(debt, 0);

		// Should set user issuanceData to 0 debtOwnership and retain debtEntryIndex of last action
		assert.deepEqual(await oikosState.issuanceData(account2), {
			initialDebtOwnership: 0,
			debtEntryIndex: 2,
		});
	});

	// These tests take a long time to run
	// ****************************************
	describe('multiple issue and burn scenarios', () => {
		it('should correctly calculate debt in a high issuance and burn scenario', async () => {
			const getRandomInt = (min, max) => {
				return min + Math.floor(Math.random() * Math.floor(max));
			};

			const totalSupply = await oikos.totalSupply();
			const account2Oikoss = toUnit('120000');
			const account1Oikoss = totalSupply.sub(account2Oikoss);

			await oikos.transfer(account1, account1Oikoss, {
				from: owner,
			}); // Issue the massive majority to account1
			await oikos.transfer(account2, account2Oikoss, {
				from: owner,
			}); // Issue a small amount to account2

			const account1AmountToIssue = await oikos.maxIssuableSynths(account1);
			await oikos.issueMaxSynths({ from: account1 });
			const debtBalance1 = await oikos.debtBalanceOf(account1, oUSD);
			assert.bnClose(debtBalance1, account1AmountToIssue);

			let expectedDebtForAccount2 = web3.utils.toBN('0');
			const totalTimesToIssue = 40;
			for (let i = 0; i < totalTimesToIssue; i++) {
				// Seems that in this case, issuing 43 each time leads to increasing the variance regularly each time.
				const amount = toUnit('43');
				await oikos.issueSynths(amount, { from: account2 });
				expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);

				const desiredAmountToBurn = toUnit(web3.utils.toBN(getRandomInt(4, 14)));
				const amountToBurn = desiredAmountToBurn.lte(expectedDebtForAccount2)
					? desiredAmountToBurn
					: expectedDebtForAccount2;
				await oikos.burnSynths(amountToBurn, { from: account2 });
				expectedDebtForAccount2 = expectedDebtForAccount2.sub(amountToBurn);

				// Useful debug logging
				// const db = await oikos.debtBalanceOf(account2, oUSD);
				// const variance = fromUnit(expectedDebtForAccount2.sub(db));
				// console.log(
				// 	`#### debtBalance: ${db}\t\t expectedDebtForAccount2: ${expectedDebtForAccount2}\t\tvariance: ${variance}`
				// );
			}
			const debtBalance = await oikos.debtBalanceOf(account2, oUSD);

			// Here we make the variance a calculation of the number of times we issue/burn.
			// This is less than ideal, but is the result of calculating the debt based on
			// the results of the issue/burn each time.
			const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('2'));
			assert.bnClose(debtBalance, expectedDebtForAccount2, variance);
		});

		it('should correctly calculate debt in a high (random) issuance and burn scenario', async () => {
			const getRandomInt = (min, max) => {
				return min + Math.floor(Math.random() * Math.floor(max));
			};

			const totalSupply = await oikos.totalSupply();
			const account2Oikoss = toUnit('120000');
			const account1Oikoss = totalSupply.sub(account2Oikoss);

			await oikos.transfer(account1, account1Oikoss, {
				from: owner,
			}); // Issue the massive majority to account1
			await oikos.transfer(account2, account2Oikoss, {
				from: owner,
			}); // Issue a small amount to account2

			const account1AmountToIssue = await oikos.maxIssuableSynths(account1);
			await oikos.issueMaxSynths({ from: account1 });
			const debtBalance1 = await oikos.debtBalanceOf(account1, oUSD);
			assert.bnClose(debtBalance1, account1AmountToIssue);

			let expectedDebtForAccount2 = web3.utils.toBN('0');
			const totalTimesToIssue = 40;
			for (let i = 0; i < totalTimesToIssue; i++) {
				// Seems that in this case, issuing 43 each time leads to increasing the variance regularly each time.
				const amount = toUnit(web3.utils.toBN(getRandomInt(40, 49)));
				await oikos.issueSynths(amount, { from: account2 });
				expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);

				const desiredAmountToBurn = toUnit(web3.utils.toBN(getRandomInt(37, 46)));
				const amountToBurn = desiredAmountToBurn.lte(expectedDebtForAccount2)
					? desiredAmountToBurn
					: expectedDebtForAccount2;
				await oikos.burnSynths(amountToBurn, { from: account2 });
				expectedDebtForAccount2 = expectedDebtForAccount2.sub(amountToBurn);

				// Useful debug logging
				// const db = await oikos.debtBalanceOf(account2, oUSD);
				// const variance = fromUnit(expectedDebtForAccount2.sub(db));
				// console.log(
				// 	`#### debtBalance: ${db}\t\t expectedDebtForAccount2: ${expectedDebtForAccount2}\t\tvariance: ${variance}`
				// );
			}
			const debtBalance = await oikos.debtBalanceOf(account2, oUSD);

			// Here we make the variance a calculation of the number of times we issue/burn.
			// This is less than ideal, but is the result of calculating the debt based on
			// the results of the issue/burn each time.
			const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('2'));
			assert.bnClose(debtBalance, expectedDebtForAccount2, variance);
		});

		it('should correctly calculate debt in a high volume contrast issuance and burn scenario', async () => {
			const totalSupply = await oikos.totalSupply();

			// Give only 100 Oikos to account2
			const account2Oikoss = toUnit('100');

			// Give the vast majority to account1 (ie. 99,999,900)
			const account1Oikoss = totalSupply.sub(account2Oikoss);

			await oikos.transfer(account1, account1Oikoss, {
				from: owner,
			}); // Issue the massive majority to account1
			await oikos.transfer(account2, account2Oikoss, {
				from: owner,
			}); // Issue a small amount to account2

			const account1AmountToIssue = await oikos.maxIssuableSynths(account1);
			await oikos.issueMaxSynths({ from: account1 });
			const debtBalance1 = await oikos.debtBalanceOf(account1, oUSD);
			assert.bnEqual(debtBalance1, account1AmountToIssue);

			let expectedDebtForAccount2 = web3.utils.toBN('0');
			const totalTimesToIssue = 40;
			for (let i = 0; i < totalTimesToIssue; i++) {
				const amount = toUnit('0.000000000000000002');
				await oikos.issueSynths(amount, { from: account2 });
				expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);
			}
			const debtBalance2 = await oikos.debtBalanceOf(account2, oUSD);

			// Here we make the variance a calculation of the number of times we issue/burn.
			// This is less than ideal, but is the result of calculating the debt based on
			// the results of the issue/burn each time.
			const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('2'));
			assert.bnClose(debtBalance2, expectedDebtForAccount2, variance);
		});
	});

	// ****************************************

	it("should prevent more issuance if the user's collaterisation changes to be insufficient", async () => {
		// Set sEUR for purposes of this test
		const timestamp1 = await currentTime();
		await exchangeRates.updateRates([sEUR], [toUnit('0.75')], timestamp1, { from: oracle });

		const issuedOikoss = web3.utils.toBN('200000');
		await oikos.transfer(account1, toUnit(issuedOikoss), {
			from: owner,
		});

		const maxIssuableSynths = await oikos.maxIssuableSynths(account1);

		// Issue
		const synthsToNotIssueYet = web3.utils.toBN('2000');
		const issuedSynths = maxIssuableSynths.sub(synthsToNotIssueYet);
		await oikos.issueSynths(issuedSynths, { from: account1 });

		// exchange into sEUR
		await oikos.exchange(oUSD, issuedSynths, sEUR, { from: account1 });

		// Increase the value of sEUR relative to oikos
		const timestamp2 = await currentTime();
		await exchangeRates.updateRates([sEUR], [toUnit('1.10')], timestamp2, { from: oracle });

		await assert.revert(oikos.issueSynths(synthsToNotIssueYet, { from: account1 }));
	});

	// Check user's collaterisation ratio

	it('should return 0 if user has no oikos when checking the collaterisation ratio', async () => {
		const ratio = await oikos.collateralisationRatio(account1);
		assert.bnEqual(ratio, new web3.utils.BN(0));
	});

	it('Any user can check the collaterisation ratio for a user', async () => {
		const issuedOikoss = web3.utils.toBN('320000');
		await oikos.transfer(account1, toUnit(issuedOikoss), {
			from: owner,
		});

		// Issue
		const issuedSynths = toUnit(web3.utils.toBN('6400'));
		await oikos.issueSynths(issuedSynths, { from: account1 });

		await oikos.collateralisationRatio(account1, { from: account2 });
	});

	it('should be able to read collaterisation ratio for a user with oikos but no debt', async () => {
		const issuedOikoss = web3.utils.toBN('30000');
		await oikos.transfer(account1, toUnit(issuedOikoss), {
			from: owner,
		});

		const ratio = await oikos.collateralisationRatio(account1);
		assert.bnEqual(ratio, new web3.utils.BN(0));
	});

	it('should be able to read collaterisation ratio for a user with oikos and debt', async () => {
		// Ensure SNX rate is set
		await updateRatesWithDefaults({ oracle: oracle });

		const issuedOikoss = web3.utils.toBN('320000');
		await oikos.transfer(account1, toUnit(issuedOikoss), {
			from: owner,
		});

		// Issue
		const issuedSynths = toUnit(web3.utils.toBN('6400'));
		await oikos.issueSynths(issuedSynths, { from: account1 });

		const ratio = await oikos.collateralisationRatio(account1, { from: account2 });
		assert.unitEqual(ratio, '0.2');
	});

	it("should include escrowed oikos when calculating a user's collaterisation ratio", async () => {
		const snx2usdRate = await exchangeRates.rateForCurrency(SNX);
		const transferredOikoss = toUnit('60000');
		await oikos.transfer(account1, transferredOikoss, {
			from: owner,
		});

		// Setup escrow
		const oneWeek = 60 * 60 * 24 * 7;
		const twelveWeeks = oneWeek * 12;
		const now = await currentTime();
		const escrowedOikoss = toUnit('30000');
		await oikos.transfer(escrow.address, escrowedOikoss, {
			from: owner,
		});
		await escrow.appendVestingEntry(
			account1,
			web3.utils.toBN(now + twelveWeeks),
			escrowedOikoss,
			{
				from: owner,
			}
		);

		// Issue
		const maxIssuable = await oikos.maxIssuableSynths(account1);
		await oikos.issueSynths(maxIssuable, { from: account1 });

		// Compare
		const collaterisationRatio = await oikos.collateralisationRatio(account1);
		const expectedCollaterisationRatio = divideDecimal(
			maxIssuable,
			multiplyDecimal(escrowedOikoss.add(transferredOikoss), snx2usdRate)
		);
		assert.bnEqual(collaterisationRatio, expectedCollaterisationRatio);
	});

	it("should include escrowed reward oikos when calculating a user's collaterisation ratio", async () => {
		const snx2usdRate = await exchangeRates.rateForCurrency(SNX);
		const transferredOikoss = toUnit('60000');
		await oikos.transfer(account1, transferredOikoss, {
			from: owner,
		});

		// Setup reward escrow
		const feePoolAccount = account6;
		await rewardEscrow.setFeePool(feePoolAccount, { from: owner });

		const escrowedOikoss = toUnit('30000');
		await oikos.transfer(rewardEscrow.address, escrowedOikoss, {
			from: owner,
		});
		await rewardEscrow.appendVestingEntry(account1, escrowedOikoss, { from: feePoolAccount });

		// Issue
		const maxIssuable = await oikos.maxIssuableSynths(account1);
		await oikos.issueSynths(maxIssuable, { from: account1 });

		// Compare
		const collaterisationRatio = await oikos.collateralisationRatio(account1);
		const expectedCollaterisationRatio = divideDecimal(
			maxIssuable,
			multiplyDecimal(escrowedOikoss.add(transferredOikoss), snx2usdRate)
		);
		assert.bnEqual(collaterisationRatio, expectedCollaterisationRatio);
	});

	it('should permit user to issue oUSD debt with only escrowed SNX as collateral (no SNX in wallet)', async () => {
		const oneWeek = 60 * 60 * 24 * 7;
		const twelveWeeks = oneWeek * 12;
		const now = await currentTime();

		// Send a price update to guarantee we're not depending on values from outside this test.
		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// ensure collateral of account1 is empty
		let collateral = await oikos.collateral(account1, { from: account1 });
		assert.bnEqual(collateral, 0);

		// ensure account1 has no SNX balance
		const snxBalance = await oikos.balanceOf(account1);
		assert.bnEqual(snxBalance, 0);

		// Append escrow amount to account1
		const escrowedAmount = toUnit('15000');
		await oikos.transfer(escrow.address, escrowedAmount, {
			from: owner,
		});
		await escrow.appendVestingEntry(account1, web3.utils.toBN(now + twelveWeeks), escrowedAmount, {
			from: owner,
		});

		// collateral should include escrowed amount
		collateral = await oikos.collateral(account1, { from: account1 });
		assert.bnEqual(collateral, escrowedAmount);

		// Issue max synths. (300 oUSD)
		await oikos.issueMaxSynths({ from: account1 });

		// There should be 300 oUSD of value for account1
		assert.bnEqual(await oikos.debtBalanceOf(account1, oUSD), toUnit('300'));
	});

	it('should permit user to issue oUSD debt with only reward escrow as collateral (no SNX in wallet)', async () => {
		// Setup reward escrow
		const feePoolAccount = account6;
		await rewardEscrow.setFeePool(feePoolAccount, { from: owner });

		// Send a price update to guarantee we're not depending on values from outside this test.
		await exchangeRates.updateRates(
			[sAUD, sEUR, SNX],
			['0.5', '1.25', '0.1'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// ensure collateral of account1 is empty
		let collateral = await oikos.collateral(account1, { from: account1 });
		assert.bnEqual(collateral, 0);

		// ensure account1 has no SNX balance
		const snxBalance = await oikos.balanceOf(account1);
		assert.bnEqual(snxBalance, 0);

		// Append escrow amount to account1
		const escrowedAmount = toUnit('15000');
		await oikos.transfer(RewardEscrow.address, escrowedAmount, {
			from: owner,
		});
		await rewardEscrow.appendVestingEntry(account1, escrowedAmount, { from: feePoolAccount });

		// collateral now should include escrowed amount
		collateral = await oikos.collateral(account1, { from: account1 });
		assert.bnEqual(collateral, escrowedAmount);

		// Issue max synths. (300 oUSD)
		await oikos.issueMaxSynths({ from: account1 });

		// There should be 300 oUSD of value for account1
		assert.bnEqual(await oikos.debtBalanceOf(account1, oUSD), toUnit('300'));
	});

	it("should permit anyone checking another user's collateral", async () => {
		const amount = toUnit('60000');
		await oikos.transfer(account1, amount, { from: owner });
		const collateral = await oikos.collateral(account1, { from: account2 });
		assert.bnEqual(collateral, amount);
	});

	it("should include escrowed oikos when checking a user's collateral", async () => {
		const oneWeek = 60 * 60 * 24 * 7;
		const twelveWeeks = oneWeek * 12;
		const now = await currentTime();
		const escrowedAmount = toUnit('15000');
		await oikos.transfer(escrow.address, escrowedAmount, {
			from: owner,
		});
		await escrow.appendVestingEntry(account1, web3.utils.toBN(now + twelveWeeks), escrowedAmount, {
			from: owner,
		});

		const amount = toUnit('60000');
		await oikos.transfer(account1, amount, { from: owner });
		const collateral = await oikos.collateral(account1, { from: account2 });
		assert.bnEqual(collateral, amount.add(escrowedAmount));
	});

	it("should include escrowed reward oikos when checking a user's collateral", async () => {
		const feePoolAccount = account6;
		const escrowedAmount = toUnit('15000');
		await oikos.transfer(rewardEscrow.address, escrowedAmount, {
			from: owner,
		});
		await rewardEscrow.setFeePool(feePoolAccount, { from: owner });
		await rewardEscrow.appendVestingEntry(account1, escrowedAmount, { from: feePoolAccount });
		const amount = toUnit('60000');
		await oikos.transfer(account1, amount, { from: owner });
		const collateral = await oikos.collateral(account1, { from: account2 });
		assert.bnEqual(collateral, amount.add(escrowedAmount));
	});

	// Stale rate check

	it('should allow anyone to check if any rates are stale', async () => {
		const instance = await ExchangeRates.deployed();
		const result = await instance.anyRateIsStale([sEUR, sAUD], { from: owner });
		assert.equal(result, false);
	});

	it("should calculate a user's remaining issuable synths", async () => {
		const transferredOikoss = toUnit('60000');
		await oikos.transfer(account1, transferredOikoss, {
			from: owner,
		});

		// Issue
		const maxIssuable = await oikos.maxIssuableSynths(account1);
		const issued = maxIssuable.div(web3.utils.toBN(3));
		await oikos.issueSynths(issued, { from: account1 });
		const expectedRemaining = maxIssuable.sub(issued);
		const remaining = await getRemainingIssuableSynths(account1);
		assert.bnEqual(expectedRemaining, remaining);
	});

	it("should correctly calculate a user's max issuable synths with escrowed oikos", async () => {
		const snx2usdRate = await exchangeRates.rateForCurrency(SNX);
		const transferredOikoss = toUnit('60000');
		await oikos.transfer(account1, transferredOikoss, {
			from: owner,
		});

		// Setup escrow
		const oneWeek = 60 * 60 * 24 * 7;
		const twelveWeeks = oneWeek * 12;
		const now = await currentTime();
		const escrowedOikoss = toUnit('30000');
		await oikos.transfer(escrow.address, escrowedOikoss, {
			from: owner,
		});
		await escrow.appendVestingEntry(
			account1,
			web3.utils.toBN(now + twelveWeeks),
			escrowedOikoss,
			{
				from: owner,
			}
		);

		const maxIssuable = await oikos.maxIssuableSynths(account1);
		// await oikos.issueSynths(maxIssuable, { from: account1 });

		// Compare
		const issuanceRatio = await oikosState.issuanceRatio();
		const expectedMaxIssuable = multiplyDecimal(
			multiplyDecimal(escrowedOikoss.add(transferredOikoss), snx2usdRate),
			issuanceRatio
		);
		assert.bnEqual(maxIssuable, expectedMaxIssuable);
	});

	// Burning Synths

	it("should successfully burn all user's synths", async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates([SNX], [toUnit('0.1')], timestamp, {
			from: oracle,
		});

		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('10000'), {
			from: owner,
		});

		// Issue
		await oikos.issueSynths(toUnit('199'), { from: account1 });

		// Then try to burn them all. Only 10 synths (and fees) should be gone.
		await oikos.burnSynths(await sUSDContract.balanceOf(account1), { from: account1 });
		assert.bnEqual(await sUSDContract.balanceOf(account1), web3.utils.toBN(0));
	});

	it('should burn the correct amount of synths', async () => {
		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('400000'), {
			from: owner,
		});

		// Issue
		await oikos.issueSynths(toUnit('3987'), { from: account1 });

		// Then try to burn some of them. There should be 3000 left.
		await oikos.burnSynths(toUnit('987'), { from: account1 });
		assert.bnEqual(await sUSDContract.balanceOf(account1), toUnit('3000'));
	});

	it("should successfully burn all user's synths even with transfer", async () => {
		// Send a price update to guarantee we're not depending on values from outside this test.

		await exchangeRates.updateRates([SNX], [toUnit('0.1')], timestamp, {
			from: oracle,
		});

		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('300000'), {
			from: owner,
		});

		// Issue
		const amountIssued = toUnit('2000');
		await oikos.issueSynths(amountIssued, { from: account1 });

		// Transfer account1's synths to account2 and back
		const amountToTransfer = toUnit('1800');
		await sUSDContract.transfer(account2, amountToTransfer, {
			from: account1,
		});
		const remainingAfterTransfer = await sUSDContract.balanceOf(account1);
		await sUSDContract.transfer(account1, await sUSDContract.balanceOf(account2), {
			from: account2,
		});

		// Calculate the amount that account1 should actually receive
		const amountReceived = await feePool.amountReceivedFromTransfer(toUnit('1800'));
		const amountReceived2 = await feePool.amountReceivedFromTransfer(amountReceived);
		const amountLostToFees = amountToTransfer.sub(amountReceived2);

		// Check that the transfer worked ok.
		const amountExpectedToBeLeftInWallet = amountIssued.sub(amountLostToFees);
		assert.bnEqual(amountReceived2.add(remainingAfterTransfer), amountExpectedToBeLeftInWallet);

		// Now burn 1000 and check we end up with the right amount
		await oikos.burnSynths(toUnit('1000'), { from: account1 });
		assert.bnEqual(
			await sUSDContract.balanceOf(account1),
			amountExpectedToBeLeftInWallet.sub(toUnit('1000'))
		);
	});

	it('should allow the last user in the system to burn all their synths to release their oikos', async () => {
		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('500000'), {
			from: owner,
		});
		await oikos.transfer(account2, toUnit('140000'), {
			from: owner,
		});
		await oikos.transfer(account3, toUnit('1400000'), {
			from: owner,
		});

		// Issue
		const issuedSynths1 = toUnit('2000');
		const issuedSynths2 = toUnit('2000');
		const issuedSynths3 = toUnit('2000');

		// Send more than their synth balance to burn all
		const burnAllSynths = toUnit('2050');

		await oikos.issueSynths(issuedSynths1, { from: account1 });
		await oikos.issueSynths(issuedSynths2, { from: account2 });
		await oikos.issueSynths(issuedSynths3, { from: account3 });

		await oikos.burnSynths(burnAllSynths, { from: account1 });
		await oikos.burnSynths(burnAllSynths, { from: account2 });
		await oikos.burnSynths(burnAllSynths, { from: account3 });

		const debtBalance1After = await oikos.debtBalanceOf(account1, oUSD);
		const debtBalance2After = await oikos.debtBalanceOf(account2, oUSD);
		const debtBalance3After = await oikos.debtBalanceOf(account3, oUSD);

		assert.bnEqual(debtBalance1After, '0');
		assert.bnEqual(debtBalance2After, '0');
		assert.bnEqual(debtBalance3After, '0');
	});

	it('should allow user to burn all synths issued even after other users have issued', async () => {
		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('500000'), {
			from: owner,
		});
		await oikos.transfer(account2, toUnit('140000'), {
			from: owner,
		});
		await oikos.transfer(account3, toUnit('1400000'), {
			from: owner,
		});

		// Issue
		const issuedSynths1 = toUnit('2000');
		const issuedSynths2 = toUnit('2000');
		const issuedSynths3 = toUnit('2000');

		await oikos.issueSynths(issuedSynths1, { from: account1 });
		await oikos.issueSynths(issuedSynths2, { from: account2 });
		await oikos.issueSynths(issuedSynths3, { from: account3 });

		const debtBalanceBefore = await oikos.debtBalanceOf(account1, oUSD);
		await oikos.burnSynths(debtBalanceBefore, { from: account1 });
		const debtBalanceAfter = await oikos.debtBalanceOf(account1, oUSD);

		assert.bnEqual(debtBalanceAfter, '0');
	});

	it('should allow a user to burn up to their balance if they try too burn too much', async () => {
		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('500000'), {
			from: owner,
		});

		// Issue
		const issuedSynths1 = toUnit('10');

		await oikos.issueSynths(issuedSynths1, { from: account1 });
		await oikos.burnSynths(issuedSynths1.add(toUnit('9000')), {
			from: account1,
		});
		const debtBalanceAfter = await oikos.debtBalanceOf(account1, oUSD);

		assert.bnEqual(debtBalanceAfter, '0');
	});

	it('should allow users to burn their debt and adjust the debtBalanceOf correctly for remaining users', async () => {
		// Give some SNX to account1
		await oikos.transfer(account1, toUnit('40000000'), {
			from: owner,
		});
		await oikos.transfer(account2, toUnit('40000000'), {
			from: owner,
		});

		// Issue
		const issuedSynths1 = toUnit('150000');
		const issuedSynths2 = toUnit('50000');

		await oikos.issueSynths(issuedSynths1, { from: account1 });
		await oikos.issueSynths(issuedSynths2, { from: account2 });

		let debtBalance1After = await oikos.debtBalanceOf(account1, oUSD);
		let debtBalance2After = await oikos.debtBalanceOf(account2, oUSD);

		// debtBalanceOf has rounding error but is within tolerance
		assert.bnClose(debtBalance1After, toUnit('150000'));
		assert.bnClose(debtBalance2After, toUnit('50000'));

		// Account 1 burns 100,000
		await oikos.burnSynths(toUnit('100000'), { from: account1 });

		debtBalance1After = await oikos.debtBalanceOf(account1, oUSD);
		debtBalance2After = await oikos.debtBalanceOf(account2, oUSD);

		assert.bnClose(debtBalance1After, toUnit('50000'));
		assert.bnClose(debtBalance2After, toUnit('50000'));
	});

	it('should revert if sender tries to issue synths with 0 amount', async () => {
		// Issue 0 amount of synth
		const issuedSynths1 = toUnit('0');

		await assert.revert(oikos.issueSynths(issuedSynths1, { from: account1 }));
	});

	describe('burnSynthsToTarget', () => {
		beforeEach(async () => {
			// Give some SNX to account1
			await oikos.transfer(account1, toUnit('40000'), {
				from: owner,
			});
			// Set SNX price to 1
			await exchangeRates.updateRates([SNX], ['1'].map(toUnit), timestamp, {
				from: oracle,
			});
			// Issue
			await oikos.issueMaxSynths({ from: account1 });
			assert.bnClose(await oikos.debtBalanceOf(account1, oUSD), toUnit('8000'));

			// Set minimumStakeTime to 1 hour
			await issuer.setMinimumStakeTime(60 * 60, { from: owner });
		});

		describe('when the SNX price drops 50%', () => {
			let maxIssuableSynths;
			beforeEach(async () => {
				await exchangeRates.updateRates([SNX], ['.5'].map(toUnit), timestamp, {
					from: oracle,
				});
				maxIssuableSynths = await oikos.maxIssuableSynths(account1);
				assert.equal(await feePool.isFeesClaimable(account1), false);
			});

			it('then the maxIssuableSynths drops 50%', async () => {
				assert.bnClose(maxIssuableSynths, toUnit('4000'));
			});
			it('then calling burnSynthsToTarget() reduces oUSD to c-ratio target', async () => {
				await oikos.burnSynthsToTarget({ from: account1 });
				assert.bnClose(await oikos.debtBalanceOf(account1, oUSD), toUnit('4000'));
			});
			it('then fees are claimable', async () => {
				await oikos.burnSynthsToTarget({ from: account1 });
				assert.equal(await feePool.isFeesClaimable(account1), true);
			});
		});

		describe('when the SNX price drops 10%', () => {
			let maxIssuableSynths;
			beforeEach(async () => {
				await exchangeRates.updateRates([SNX], ['.9'].map(toUnit), timestamp, {
					from: oracle,
				});
				maxIssuableSynths = await oikos.maxIssuableSynths(account1);
			});

			it('then the maxIssuableSynths drops 10%', async () => {
				assert.bnEqual(maxIssuableSynths, toUnit('7200'));
			});
			it('then calling burnSynthsToTarget() reduces oUSD to c-ratio target', async () => {
				await oikos.burnSynthsToTarget({ from: account1 });
				assert.bnEqual(await oikos.debtBalanceOf(account1, oUSD), toUnit('7200'));
			});
			it('then fees are claimable', async () => {
				await oikos.burnSynthsToTarget({ from: account1 });
				assert.equal(await feePool.isFeesClaimable(account1), true);
			});
		});

		describe('when the SNX price drops 90%', () => {
			let maxIssuableSynths;
			beforeEach(async () => {
				await exchangeRates.updateRates([SNX], ['.1'].map(toUnit), timestamp, {
					from: oracle,
				});
				maxIssuableSynths = await oikos.maxIssuableSynths(account1);
			});

			it('then the maxIssuableSynths drops 10%', async () => {
				assert.bnEqual(maxIssuableSynths, toUnit('800'));
			});
			it('then calling burnSynthsToTarget() reduces oUSD to c-ratio target', async () => {
				await oikos.burnSynthsToTarget({ from: account1 });
				assert.bnEqual(await oikos.debtBalanceOf(account1, oUSD), toUnit('800'));
			});
			it('then fees are claimable', async () => {
				await oikos.burnSynthsToTarget({ from: account1 });
				assert.equal(await feePool.isFeesClaimable(account1), true);
			});
		});

		describe('when the SNX price increases 100%', () => {
			let maxIssuableSynths;
			beforeEach(async () => {
				await exchangeRates.updateRates([SNX], ['2'].map(toUnit), timestamp, {
					from: oracle,
				});
				maxIssuableSynths = await oikos.maxIssuableSynths(account1);
			});

			it('then the maxIssuableSynths increases 100%', async () => {
				assert.bnEqual(maxIssuableSynths, toUnit('16000'));
			});
			it('then calling burnSynthsToTarget() reverts', async () => {
				await assert.revert(oikos.burnSynthsToTarget({ from: account1 }));
			});
		});
	});

	describe('burnSynths() after exchange()', () => {
		describe('given the waiting period is set to 60s', () => {
			let amount;
			beforeEach(async () => {
				amount = toUnit('1250');
				await setExchangeWaitingPeriod({ owner, secs: 60 });
				// set the exchange fee to 0 to effectively ignore it
				await setExchangeFee({ owner, exchangeFeeRate: '0' });
			});
			describe('and a user has 1250 oUSD issued', () => {
				beforeEach(async () => {
					await oikos.transfer(account1, toUnit('1000000'), { from: owner });
					await oikos.issueSynths(amount, { from: account1 });
				});
				describe('and is has been exchanged into sEUR at a rate of 1.25:1 and the waiting period has expired', () => {
					beforeEach(async () => {
						await oikos.exchange(oUSD, amount, sEUR, { from: account1 });
						await fastForward(90); // make sure the waiting period is expired on this
					});
					describe('and they have exchanged all of it back into oUSD', () => {
						// let sUSDBalanceAfterExchange;
						beforeEach(async () => {
							await oikos.exchange(sEUR, toUnit('1000'), oUSD, { from: account1 });
							// sUSDBalanceAfterExchange = await sUSDContract.balanceOf(account1);
						});
						describe('when they attempt to burn the oUSD', () => {
							it('then it fails as the waiting period is ongoing', async () => {
								await assert.revert(
									oikos.burnSynths(amount, { from: account1 }),
									'Cannot settle during waiting period'
								);
							});
						});
						describe('and 60s elapses with no change in the sEUR rate', () => {
							beforeEach(async () => {
								fastForward(60);
							});
							describe('when they attempt to burn the oUSD', () => {
								let txn;
								beforeEach(async () => {
									txn = await oikos.burnSynths(amount, { from: account1 });
								});
								it('then it succeeds and burns the entire oUSD amount', async () => {
									const logs = await getDecodedLogs({ hash: txn.tx });
									const sUSDProxy = await sUSDContract.proxy();

									decodedEventEqual({
										event: 'Burned',
										emittedFrom: sUSDProxy,
										args: [account1, amount],
										log: logs.find(({ name }) => name === 'Burned'),
									});

									const sUSDBalance = await sUSDContract.balanceOf(account1);
									assert.equal(sUSDBalance, '0');

									const debtBalance = await oikos.debtBalanceOf(account1, oUSD);
									assert.equal(debtBalance, '0');
								});
							});
						});
						describe('and the sEUR price decreases by 20% to 1', () => {
							beforeEach(async () => {
								// fastForward(1);
								// timestamp = await currentTime();
								await exchangeRates.updateRates([sEUR], ['1'].map(toUnit), timestamp, {
									from: oracle,
								});
							});
							describe('and 60s elapses', () => {
								beforeEach(async () => {
									fastForward(60);
								});
								describe('when they attempt to burn the entire amount oUSD', () => {
									let txn;
									beforeEach(async () => {
										txn = await oikos.burnSynths(amount, { from: account1 });
									});
									it('then it succeeds and burns their oUSD minus the reclaim amount from settlement', async () => {
										const logs = await getDecodedLogs({ hash: txn.tx });
										const sUSDProxy = await sUSDContract.proxy();

										decodedEventEqual({
											event: 'Burned',
											emittedFrom: sUSDProxy,
											args: [account1, amount.sub(toUnit('250'))],
											log: logs
												.reverse()
												.filter(l => !!l)
												.find(({ name }) => name === 'Burned'),
										});

										const sUSDBalance = await sUSDContract.balanceOf(account1);
										assert.equal(sUSDBalance, '0');
									});
									it('and their debt balance is now 0 because they are the only debt holder in the system', async () => {
										// the debt balance remaining is what was reclaimed from the exchange
										const debtBalance = await oikos.debtBalanceOf(account1, oUSD);
										// because this user is the only one holding debt, when we burn 250 oUSD in a reclaim,
										// it removes it from the totalIssuedSynths and
										assert.equal(debtBalance, '0');
									});
								});
								describe('when another user also has the same amount of debt', () => {
									beforeEach(async () => {
										await oikos.transfer(account2, toUnit('1000000'), { from: owner });
										await oikos.issueSynths(amount, { from: account2 });
									});
									describe('when the first user attempts to burn the entire amount oUSD', () => {
										let txn;
										beforeEach(async () => {
											txn = await oikos.burnSynths(amount, { from: account1 });
										});
										it('then it succeeds and burns their oUSD minus the reclaim amount from settlement', async () => {
											const logs = await getDecodedLogs({ hash: txn.tx });
											const sUSDProxy = await sUSDContract.proxy();

											decodedEventEqual({
												event: 'Burned',
												emittedFrom: sUSDProxy,
												args: [account1, amount.sub(toUnit('250'))],
												log: logs
													.reverse()
													.filter(l => !!l)
													.find(({ name }) => name === 'Burned'),
											});

											const sUSDBalance = await sUSDContract.balanceOf(account1);
											assert.equal(sUSDBalance, '0');
										});
										it('and their debt balance is now half of the reclaimed balance because they owe half of the pool', async () => {
											// the debt balance remaining is what was reclaimed from the exchange
											const debtBalance = await oikos.debtBalanceOf(account1, oUSD);
											// because this user is holding half the debt, when we burn 250 oUSD in a reclaim,
											// it removes it from the totalIssuedSynths and so both users have half of 250
											// in owing synths
											assert.bnEqual(debtBalance, divideDecimal('250', 2));
										});
									});
								});
							});
						});
					});
				});
			});
		});
	});
});
