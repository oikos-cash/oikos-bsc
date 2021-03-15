require('.'); // import common test scaffolding

const ExchangeRates = artifacts.require('ExchangeRates');
const Escrow = artifacts.require('OikosEscrow');
const RewardEscrow = artifacts.require('RewardEscrow');
const SupplySchedule = artifacts.require('SupplySchedule');
const OikosState = artifacts.require('OikosState');
const Oikos = artifacts.require('Oikos');
const Synth = artifacts.require('Synth');
const AddressResolver = artifacts.require('AddressResolver');
const EtherCollateral = artifacts.require('EtherCollateral');
const MockEtherCollateral = artifacts.require('MockEtherCollateral');

const {
	currentTime,
	fastForward,
	fastForwardTo,
	divideDecimal,
	multiplyDecimal,
	toUnit,
	fromUnit,
	ZERO_ADDRESS,
} = require('../utils/testUtils');

const { updateRatesWithDefaults } = require('../utils/setupUtils');

const { toBytes32 } = require('../..');

contract('Oikos', async accounts => {
	const [oUSD, sAUD, sEUR, SNX, oETH] = ['oUSD', 'sAUD', 'sEUR', 'SNX', 'oETH'].map(toBytes32);

	const [deployerAccount, owner, account1, account2, account3] = accounts;

	let oikos,
		exchangeRates,
		supplySchedule,
		escrow,
		oracle,
		timestamp,
		addressResolver,
		oikosState;

	const getRemainingIssuableSynths = async account =>
		(await oikos.remainingIssuableSynths(account))[0];

	beforeEach(async () => {
		// Save ourselves from having to await deployed() in every single test.
		// We do this in a beforeEach instead of before to ensure we isolate
		// contract interfaces to prevent test bleed.
		exchangeRates = await ExchangeRates.deployed();
		supplySchedule = await SupplySchedule.deployed();
		escrow = await Escrow.deployed();

		oikos = await Oikos.deployed();
		oikosState = await OikosState.deployed();

		addressResolver = await AddressResolver.deployed();

		// Send a price update to guarantee we're not stale.
		oracle = await exchangeRates.oracle();
		timestamp = await currentTime();
	});

	describe('constructor', () => {
		it('should set constructor params on deployment', async () => {
			const SYNTHETIX_TOTAL_SUPPLY = web3.utils.toWei('100000000');
			const instance = await Oikos.new(
				account1,
				account2,
				owner,
				SYNTHETIX_TOTAL_SUPPLY,
				addressResolver.address,
				{
					from: deployerAccount,
				}
			);

			assert.equal(await instance.proxy(), account1);
			assert.equal(await instance.tokenState(), account2);
			assert.equal(await instance.owner(), owner);
			assert.equal(await instance.totalSupply(), SYNTHETIX_TOTAL_SUPPLY);
			assert.equal(await instance.resolver(), addressResolver.address);
		});

		it('should set constructor params on upgrade to new totalSupply', async () => {
			const YEAR_2_SYNTHETIX_TOTAL_SUPPLY = web3.utils.toWei('175000000');
			const instance = await Oikos.new(
				account1,
				account2,
				owner,
				YEAR_2_SYNTHETIX_TOTAL_SUPPLY,
				addressResolver.address,
				{
					from: deployerAccount,
				}
			);

			assert.equal(await instance.proxy(), account1);
			assert.equal(await instance.tokenState(), account2);
			assert.equal(await instance.owner(), owner);
			assert.equal(await instance.totalSupply(), YEAR_2_SYNTHETIX_TOTAL_SUPPLY);
			assert.equal(await instance.resolver(), addressResolver.address);
		});
	});

	describe('adding and removing synths', () => {
		it('should allow adding a Synth contract', async () => {
			const previousSynthCount = await oikos.availableSynthCount();

			const synth = await Synth.new(
				account1,
				account2,
				'Synth XYZ123',
				'sXYZ123',
				owner,
				toBytes32('sXYZ123'),
				web3.utils.toWei('0'), // _totalSupply
				addressResolver.address,
				{ from: deployerAccount }
			);

			await oikos.addSynth(synth.address, { from: owner });

			// Assert that we've successfully added a Synth
			assert.bnEqual(
				await oikos.availableSynthCount(),
				previousSynthCount.add(web3.utils.toBN(1))
			);
			// Assert that it's at the end of the array
			assert.equal(await oikos.availableSynths(previousSynthCount), synth.address);
			// Assert that it's retrievable by its currencyKey
			assert.equal(await oikos.synths(toBytes32('sXYZ123')), synth.address);
		});

		it('should disallow adding a Synth contract when the user is not the owner', async () => {
			const synth = await Synth.new(
				account1,
				account2,
				'Synth XYZ123',
				'sXYZ123',
				owner,
				toBytes32('sXYZ123'),
				web3.utils.toWei('0'), // _totalSupply
				addressResolver.address,
				{ from: deployerAccount }
			);

			await assert.revert(oikos.addSynth(synth.address, { from: account1 }));
		});

		it('should disallow double adding a Synth contract with the same address', async () => {
			const synth = await Synth.new(
				account1,
				account2,
				'Synth XYZ123',
				'sXYZ123',
				owner,
				toBytes32('sXYZ123'),
				web3.utils.toWei('0'), // _totalSupply
				addressResolver.address,
				{ from: deployerAccount }
			);

			await oikos.addSynth(synth.address, { from: owner });
			await assert.revert(oikos.addSynth(synth.address, { from: owner }));
		});

		it('should disallow double adding a Synth contract with the same currencyKey', async () => {
			const synth1 = await Synth.new(
				account1,
				account2,
				'Synth XYZ123',
				'sXYZ123',
				owner,
				toBytes32('sXYZ123'),
				web3.utils.toWei('0'), // _totalSupply
				addressResolver.address,
				{ from: deployerAccount }
			);

			const synth2 = await Synth.new(
				account1,
				account2,
				'Synth XYZ123',
				'sXYZ123',
				owner,
				toBytes32('sXYZ123'),
				web3.utils.toWei('0'), // _totalSupply
				addressResolver.address,
				{ from: deployerAccount }
			);

			await oikos.addSynth(synth1.address, { from: owner });
			await assert.revert(oikos.addSynth(synth2.address, { from: owner }));
		});

		it('should allow removing a Synth contract when it has no issued balance', async () => {
			// Note: This test depends on state in the migration script, that there are hooked up synths
			// without balances and we just remove one.
			const currencyKey = sAUD;
			const synthCount = await oikos.availableSynthCount();

			assert.notEqual(await oikos.synths(currencyKey), ZERO_ADDRESS);

			await oikos.removeSynth(currencyKey, { from: owner });

			// Assert that we have one less synth, and that the specific currency key is gone.
			assert.bnEqual(await oikos.availableSynthCount(), synthCount.sub(web3.utils.toBN(1)));
			assert.equal(await oikos.synths(currencyKey), ZERO_ADDRESS);

			// TODO: Check that an event was successfully fired ?
		});

		it('should disallow removing a Synth contract when it has an issued balance', async () => {
			// Note: This test depends on state in the migration script, that there are hooked up synths
			// without balances
			const sAUDContractAddress = await oikos.synths(sAUD);

			// Assert that we can remove the synth and add it back in before we do anything.
			await oikos.removeSynth(sAUD, { from: owner });
			await oikos.addSynth(sAUDContractAddress, { from: owner });

			// Issue one sUSd
			await oikos.issueSynths(toUnit('1'), { from: owner });

			// exchange to sAUD
			await oikos.exchange(oUSD, toUnit('1'), sAUD, { from: owner });

			// Assert that we can't remove the synth now
			await assert.revert(oikos.removeSynth(sAUD, { from: owner }));
		});

		it('should disallow removing a Synth contract when requested by a non-owner', async () => {
			// Note: This test depends on state in the migration script, that there are hooked up synths
			// without balances
			await assert.revert(oikos.removeSynth(sEUR, { from: account1 }));
		});

		it('should revert when requesting to remove a non-existent synth', async () => {
			// Note: This test depends on state in the migration script, that there are hooked up synths
			// without balances
			const currencyKey = toBytes32('NOPE');

			// Assert that we can't remove the synth
			await assert.revert(oikos.removeSynth(currencyKey, { from: owner }));
		});
	});

	describe('totalIssuedSynths()', () => {
		it('should correctly calculate the total issued synths in a single currency', async () => {
			// Two people issue 10 oUSD each. Assert that total issued value is 20 oUSD.

			// Send a price update to guarantee we're not depending on values from outside this test.

			await exchangeRates.updateRates(
				[sAUD, sEUR, SNX],
				['0.5', '1.25', '0.1'].map(toUnit),
				timestamp,
				{ from: oracle }
			);

			// Give some SNX to account1 and account2
			await oikos.transfer(account1, toUnit('1000'), { from: owner });
			await oikos.transfer(account2, toUnit('1000'), { from: owner });

			// Issue 10 oUSD each
			await oikos.issueSynths(toUnit('10'), { from: account1 });
			await oikos.issueSynths(toUnit('10'), { from: account2 });

			// Assert that there's 20 oUSD of value in the system
			assert.bnEqual(await oikos.totalIssuedSynths(oUSD), toUnit('20'));
		});

		it('should correctly calculate the total issued synths in multiple currencies', async () => {
			// Alice issues 10 oUSD. Bob issues 20 sAUD. Assert that total issued value is 20 oUSD, and 40 sAUD.

			// Send a price update to guarantee we're not depending on values from outside this test.

			await exchangeRates.updateRates(
				[sAUD, sEUR, SNX],
				['0.5', '1.25', '0.1'].map(toUnit),
				timestamp,
				{ from: oracle }
			);

			// Give some SNX to account1 and account2
			await oikos.transfer(account1, toUnit('1000'), { from: owner });
			await oikos.transfer(account2, toUnit('1000'), { from: owner });

			// Issue 10 oUSD each
			await oikos.issueSynths(toUnit('10'), { from: account1 });
			await oikos.issueSynths(toUnit('20'), { from: account2 });

			await oikos.exchange(oUSD, toUnit('20'), sAUD, { from: account2 });

			// Assert that there's 30 oUSD of value in the system
			assert.bnEqual(await oikos.totalIssuedSynths(oUSD), toUnit('30'));

			// And that there's 60 sAUD (minus fees) of value in the system
			assert.bnEqual(await oikos.totalIssuedSynths(sAUD), toUnit('60'));
		});

		it('should return the correct value for the different quantity of total issued synths', async () => {
			// Send a price update to guarantee we're not depending on values from outside this test.

			const rates = ['0.5', '1.25', '0.1'].map(toUnit);

			await exchangeRates.updateRates([sAUD, sEUR, SNX], rates, timestamp, { from: oracle });

			const aud2usdRate = await exchangeRates.rateForCurrency(sAUD);
			// const eur2usdRate = await exchangeRates.rateForCurrency(sEUR);

			// Give some SNX to account1 and account2
			await oikos.transfer(account1, toUnit('100000'), {
				from: owner,
			});
			await oikos.transfer(account2, toUnit('100000'), {
				from: owner,
			});

			const issueAmountUSD = toUnit('100');
			const exchangeAmountToAUD = toUnit('95');
			const exchangeAmountToEUR = toUnit('5');

			// Issue
			await oikos.issueSynths(issueAmountUSD, { from: account1 });
			await oikos.issueSynths(issueAmountUSD, { from: account2 });

			// Exchange
			await oikos.exchange(oUSD, exchangeAmountToEUR, sEUR, { from: account1 });
			await oikos.exchange(oUSD, exchangeAmountToEUR, sEUR, { from: account2 });

			await oikos.exchange(oUSD, exchangeAmountToAUD, sAUD, { from: account1 });
			await oikos.exchange(oUSD, exchangeAmountToAUD, sAUD, { from: account2 });

			const totalIssuedAUD = await oikos.totalIssuedSynths(sAUD);

			assert.bnClose(totalIssuedAUD, divideDecimal(toUnit('200'), aud2usdRate));
		});

		it('should not allow checking total issued synths when a rate other than the priced currency is stale', async () => {
			await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));

			await exchangeRates.updateRates([SNX, sAUD], ['0.1', '0.78'].map(toUnit), timestamp, {
				from: oracle,
			});
			await assert.revert(oikos.totalIssuedSynths(sAUD));
		});

		it('should not allow checking total issued synths when the priced currency is stale', async () => {
			await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));

			await exchangeRates.updateRates([SNX, sEUR], ['0.1', '1.25'].map(toUnit), timestamp, {
				from: oracle,
			});
			await assert.revert(oikos.totalIssuedSynths(sAUD));
		});
	});

	describe('transfer()', () => {
		it('should transfer using the ERC20 transfer function', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all SNX.

			assert.bnEqual(await oikos.totalSupply(), await oikos.balanceOf(owner));

			const transaction = await oikos.transfer(account1, toUnit('10'), { from: owner });
			assert.eventEqual(transaction, 'Transfer', {
				from: owner,
				to: account1,
				value: toUnit('10'),
			});

			assert.bnEqual(await oikos.balanceOf(account1), toUnit('10'));
		});

		it('should revert when exceeding locked oikos and calling the ERC20 transfer function', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all SNX.
			assert.bnEqual(await oikos.totalSupply(), await oikos.balanceOf(owner));

			// Issue max synths.
			await oikos.issueMaxSynths({ from: owner });

			// Try to transfer 0.000000000000000001 SNX
			await assert.revert(oikos.transfer(account1, '1', { from: owner }));
		});

		it('should transfer using the ERC20 transferFrom function', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all SNX.
			const previousOwnerBalance = await oikos.balanceOf(owner);
			assert.bnEqual(await oikos.totalSupply(), previousOwnerBalance);

			// Approve account1 to act on our behalf for 10 SNX.
			let transaction = await oikos.approve(account1, toUnit('10'), { from: owner });
			assert.eventEqual(transaction, 'Approval', {
				owner: owner,
				spender: account1,
				value: toUnit('10'),
			});

			// Assert that transferFrom works.
			transaction = await oikos.transferFrom(owner, account2, toUnit('10'), { from: account1 });
			assert.eventEqual(transaction, 'Transfer', {
				from: owner,
				to: account2,
				value: toUnit('10'),
			});

			// Assert that account2 has 10 SNX and owner has 10 less SNX
			assert.bnEqual(await oikos.balanceOf(account2), toUnit('10'));
			assert.bnEqual(await oikos.balanceOf(owner), previousOwnerBalance.sub(toUnit('10')));

			// Assert that we can't transfer more even though there's a balance for owner.
			await assert.revert(
				oikos.transferFrom(owner, account2, '1', {
					from: account1,
				})
			);
		});

		it('should revert when exceeding locked oikos and calling the ERC20 transferFrom function', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all SNX.
			assert.bnEqual(await oikos.totalSupply(), await oikos.balanceOf(owner));

			// Send a price update to guarantee we're not depending on values from outside this test.

			await exchangeRates.updateRates(
				[sAUD, sEUR, SNX],
				['0.5', '1.25', '0.1'].map(toUnit),
				timestamp,
				{ from: oracle }
			);

			// Approve account1 to act on our behalf for 10 SNX.
			const transaction = await oikos.approve(account1, toUnit('10'), { from: owner });
			assert.eventEqual(transaction, 'Approval', {
				owner: owner,
				spender: account1,
				value: toUnit('10'),
			});

			// Issue max synths
			await oikos.issueMaxSynths({ from: owner });

			// Assert that transferFrom fails even for the smallest amount of SNX.
			await assert.revert(
				oikos.transferFrom(owner, account2, '1', {
					from: account1,
				})
			);
		});

		it('should not allow transfer if the exchange rate for oikos is stale', async () => {
			// Give some SNX to account1 & account2
			const value = toUnit('300');
			await oikos.transfer(account1, toUnit('10000'), {
				from: owner,
			});
			await oikos.transfer(account2, toUnit('10000'), {
				from: owner,
			});

			// Ensure that we can do a successful transfer before rates go stale
			await oikos.transfer(account2, value, { from: account1 });

			await oikos.approve(account3, value, { from: account2 });
			await oikos.transferFrom(account2, account1, value, {
				from: account3,
			});

			// Now jump forward in time so the rates are stale
			await fastForward((await exchangeRates.rateStalePeriod()) + 1);

			// Send a price update to guarantee we're not depending on values from outside this test.

			await exchangeRates.updateRates([sAUD, sEUR], ['0.5', '1.25'].map(toUnit), timestamp, {
				from: oracle,
			});

			// Subsequent transfers fail
			await assert.revert(oikos.transfer(account2, value, { from: account1 }));

			await oikos.approve(account3, value, { from: account2 });
			await assert.revert(
				oikos.transferFrom(account2, account1, value, {
					from: account3,
				})
			);
		});

		it('should not allow transfer of oikos in escrow', async () => {
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

			// Ensure the transfer fails as all the oikos are in escrow
			await assert.revert(oikos.transfer(account2, toUnit('100'), { from: account1 }));
		});

		it('should not be possible to transfer locked oikos', async () => {
			const issuedOikoss = web3.utils.toBN('200000');
			await oikos.transfer(account1, toUnit(issuedOikoss), {
				from: owner,
			});

			// Issue
			const amountIssued = toUnit('2000');
			await oikos.issueSynths(amountIssued, { from: account1 });

			await assert.revert(
				oikos.transfer(account2, toUnit(issuedOikoss), {
					from: account1,
				})
			);
		});

		it("should lock newly received oikos if the user's collaterisation is too high", async () => {
			// Set sEUR for purposes of this test
			const timestamp1 = await currentTime();
			await exchangeRates.updateRates([sEUR], [toUnit('0.75')], timestamp1, { from: oracle });

			const issuedOikoss = web3.utils.toBN('200000');
			await oikos.transfer(account1, toUnit(issuedOikoss), {
				from: owner,
			});
			await oikos.transfer(account2, toUnit(issuedOikoss), {
				from: owner,
			});

			const maxIssuableSynths = await oikos.maxIssuableSynths(account1);

			// Issue
			await oikos.issueSynths(maxIssuableSynths, { from: account1 });

			// Exchange into sEUR
			await oikos.exchange(oUSD, maxIssuableSynths, sEUR, { from: account1 });

			// Ensure that we can transfer in and out of the account successfully
			await oikos.transfer(account1, toUnit('10000'), {
				from: account2,
			});
			await oikos.transfer(account2, toUnit('10000'), {
				from: account1,
			});

			// Increase the value of sEUR relative to oikos
			const timestamp2 = await currentTime();
			await exchangeRates.updateRates([sEUR], [toUnit('2.10')], timestamp2, { from: oracle });

			// Ensure that the new oikos account1 receives cannot be transferred out.
			await oikos.transfer(account1, toUnit('10000'), {
				from: account2,
			});
			await assert.revert(oikos.transfer(account2, toUnit('10000'), { from: account1 }));
		});

		it('should unlock oikos when collaterisation ratio changes', async () => {
			// Set sAUD for purposes of this test
			const timestamp1 = await currentTime();
			const aud2usdrate = toUnit('2');

			await exchangeRates.updateRates([sAUD], [aud2usdrate], timestamp1, { from: oracle });

			const issuedOikoss = web3.utils.toBN('200000');
			await oikos.transfer(account1, toUnit(issuedOikoss), {
				from: owner,
			});

			// Issue
			const issuedSynths = await oikos.maxIssuableSynths(account1);
			await oikos.issueSynths(issuedSynths, { from: account1 });
			const remainingIssuable = await getRemainingIssuableSynths(account1);
			assert.bnClose(remainingIssuable, '0');

			const transferable1 = await oikos.transferableOikos(account1);
			assert.bnEqual(transferable1, '0');

			// Exchange into sAUD
			await oikos.exchange(oUSD, issuedSynths, sAUD, { from: account1 });

			// Increase the value of sAUD relative to oikos
			const timestamp2 = await currentTime();
			const newAUDExchangeRate = toUnit('1');
			await exchangeRates.updateRates([sAUD], [newAUDExchangeRate], timestamp2, { from: oracle });

			const transferable2 = await oikos.transferableOikos(account1);
			assert.equal(transferable2.gt(toUnit('1000')), true);
		});
	});

	describe('debtBalance()', () => {
		it('should not change debt balance % if exchange rates change', async () => {
			let newAUDRate = toUnit('0.5');
			let timestamp = await currentTime();
			await exchangeRates.updateRates([sAUD], [newAUDRate], timestamp, { from: oracle });

			await oikos.transfer(account1, toUnit('20000'), {
				from: owner,
			});
			await oikos.transfer(account2, toUnit('20000'), {
				from: owner,
			});

			const amountIssuedAcc1 = toUnit('30');
			const amountIssuedAcc2 = toUnit('50');
			await oikos.issueSynths(amountIssuedAcc1, { from: account1 });
			await oikos.issueSynths(amountIssuedAcc2, { from: account2 });
			await oikos.exchange(oUSD, amountIssuedAcc2, sAUD, { from: account2 });

			const PRECISE_UNIT = web3.utils.toWei(web3.utils.toBN('1'), 'gether');
			let totalIssuedSynthsUSD = await oikos.totalIssuedSynths(oUSD);
			const account1DebtRatio = divideDecimal(amountIssuedAcc1, totalIssuedSynthsUSD, PRECISE_UNIT);
			const account2DebtRatio = divideDecimal(amountIssuedAcc2, totalIssuedSynthsUSD, PRECISE_UNIT);

			timestamp = await currentTime();
			newAUDRate = toUnit('1.85');
			await exchangeRates.updateRates([sAUD], [newAUDRate], timestamp, { from: oracle });

			totalIssuedSynthsUSD = await oikos.totalIssuedSynths(oUSD);
			const conversionFactor = web3.utils.toBN(1000000000);
			const expectedDebtAccount1 = multiplyDecimal(
				account1DebtRatio,
				totalIssuedSynthsUSD.mul(conversionFactor),
				PRECISE_UNIT
			).div(conversionFactor);
			const expectedDebtAccount2 = multiplyDecimal(
				account2DebtRatio,
				totalIssuedSynthsUSD.mul(conversionFactor),
				PRECISE_UNIT
			).div(conversionFactor);

			assert.bnClose(await oikos.debtBalanceOf(account1, oUSD), expectedDebtAccount1);
			assert.bnClose(await oikos.debtBalanceOf(account2, oUSD), expectedDebtAccount2);
		});

		it("should correctly calculate a user's debt balance without prior issuance", async () => {
			await oikos.transfer(account1, toUnit('200000'), {
				from: owner,
			});
			await oikos.transfer(account2, toUnit('10000'), {
				from: owner,
			});

			const debt1 = await oikos.debtBalanceOf(account1, toBytes32('oUSD'));
			const debt2 = await oikos.debtBalanceOf(account2, toBytes32('oUSD'));
			assert.bnEqual(debt1, 0);
			assert.bnEqual(debt2, 0);
		});

		it("should correctly calculate a user's debt balance with prior issuance", async () => {
			// Give some SNX to account1
			await oikos.transfer(account1, toUnit('200000'), {
				from: owner,
			});

			// Issue
			const issuedSynths = toUnit('1001');
			await oikos.issueSynths(issuedSynths, { from: account1 });

			const debt = await oikos.debtBalanceOf(account1, toBytes32('oUSD'));
			assert.bnEqual(debt, issuedSynths);
		});
	});

	describe('maxIssuableSynths()', () => {
		it("should correctly calculate a user's maximum issuable synths without prior issuance", async () => {
			const rate = await exchangeRates.rateForCurrency(toBytes32('SNX'));
			const issuedOikoss = web3.utils.toBN('200000');
			await oikos.transfer(account1, toUnit(issuedOikoss), {
				from: owner,
			});
			const issuanceRatio = await oikosState.issuanceRatio();

			const expectedIssuableSynths = multiplyDecimal(
				toUnit(issuedOikoss),
				multiplyDecimal(rate, issuanceRatio)
			);
			const maxIssuableSynths = await oikos.maxIssuableSynths(account1);

			assert.bnEqual(expectedIssuableSynths, maxIssuableSynths);
		});

		it("should correctly calculate a user's maximum issuable synths without any SNX", async () => {
			const maxIssuableSynths = await oikos.maxIssuableSynths(account1);
			assert.bnEqual(0, maxIssuableSynths);
		});

		it("should correctly calculate a user's maximum issuable synths with prior issuance", async () => {
			const snx2usdRate = await exchangeRates.rateForCurrency(SNX);

			const issuedOikoss = web3.utils.toBN('320001');
			await oikos.transfer(account1, toUnit(issuedOikoss), {
				from: owner,
			});

			const issuanceRatio = await oikosState.issuanceRatio();
			const amountIssued = web3.utils.toBN('1234');
			await oikos.issueSynths(toUnit(amountIssued), { from: account1 });

			const expectedIssuableSynths = multiplyDecimal(
				toUnit(issuedOikoss),
				multiplyDecimal(snx2usdRate, issuanceRatio)
			);

			const maxIssuableSynths = await oikos.maxIssuableSynths(account1);
			assert.bnEqual(expectedIssuableSynths, maxIssuableSynths);
		});

		it('should error when calculating maximum issuance when the SNX rate is stale', async () => {
			// Add stale period to the time to ensure we go stale.
			await fastForward((await exchangeRates.rateStalePeriod()) + 1);

			await exchangeRates.updateRates([sAUD, sEUR], ['0.5', '1.25'].map(toUnit), timestamp, {
				from: oracle,
			});

			await assert.revert(oikos.maxIssuableSynths(account1));
		});

		it('should error when calculating maximum issuance when the currency rate is stale', async () => {
			// Add stale period to the time to ensure we go stale.
			await fastForward((await exchangeRates.rateStalePeriod()) + 1);

			await exchangeRates.updateRates([sEUR, SNX], ['1.25', '0.12'].map(toUnit), timestamp, {
				from: oracle,
			});

			await assert.revert(oikos.maxIssuableSynths(account1));
		});
	});

	describe('remainingIssuableSynths()', () => {
		it("should correctly calculate a user's remaining issuable synths with prior issuance", async () => {
			const snx2usdRate = await exchangeRates.rateForCurrency(SNX);
			const issuanceRatio = await oikosState.issuanceRatio();

			const issuedOikoss = web3.utils.toBN('200012');
			await oikos.transfer(account1, toUnit(issuedOikoss), {
				from: owner,
			});

			// Issue
			const amountIssued = toUnit('2011');
			await oikos.issueSynths(amountIssued, { from: account1 });

			const expectedIssuableSynths = multiplyDecimal(
				toUnit(issuedOikoss),
				multiplyDecimal(snx2usdRate, issuanceRatio)
			).sub(amountIssued);

			const remainingIssuable = await getRemainingIssuableSynths(account1);
			assert.bnEqual(remainingIssuable, expectedIssuableSynths);
		});

		it("should correctly calculate a user's remaining issuable synths without prior issuance", async () => {
			const snx2usdRate = await exchangeRates.rateForCurrency(SNX);
			const issuanceRatio = await oikosState.issuanceRatio();

			const issuedOikoss = web3.utils.toBN('20');
			await oikos.transfer(account1, toUnit(issuedOikoss), {
				from: owner,
			});

			const expectedIssuableSynths = multiplyDecimal(
				toUnit(issuedOikoss),
				multiplyDecimal(snx2usdRate, issuanceRatio)
			);

			const remainingIssuable = await getRemainingIssuableSynths(account1);
			assert.bnEqual(remainingIssuable, expectedIssuableSynths);
		});
	});

	describe('mint() - inflationary supply minting', async () => {
		// These tests are using values modeled from https://sips.oikos.io/sips/sip-23
		// https://docs.google.com/spreadsheets/d/1a5r9aFP5bh6wGG4-HIW2MWPf4yMthZvesZOurnG-v_8/edit?ts=5deef2a7#gid=0
		const INITIAL_WEEKLY_SUPPLY = 75e6 / 52;

		const DAY = 86400;
		const WEEK = 604800;

		const INFLATION_START_DATE = 1551830400; // 2019-03-06T00:00:00+00:00

		it('should allow oikos contract to mint inflationary decay for 234 weeks', async () => {
			// fast forward EVM to end of inflation supply decay at week 234
			const week234 = INFLATION_START_DATE + WEEK * 234;
			await fastForwardTo(new Date(week234 * 1000));
			await updateRatesWithDefaults({ oracle: oracle });

			const existingSupply = await oikos.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();
			const mintableSupplyDecimal = parseFloat(fromUnit(mintableSupply));
			const currentRewardEscrowBalance = await oikos.balanceOf(RewardEscrow.address);

			// Call mint on Oikos
			await oikos.mint();

			const newTotalSupply = await oikos.totalSupply();
			const newTotalSupplyDecimal = parseFloat(fromUnit(newTotalSupply));
			const minterReward = await supplySchedule.minterReward();

			const expectedEscrowBalance = currentRewardEscrowBalance
				.add(mintableSupply)
				.sub(minterReward);

			// Here we are only checking to 2 decimal places from the excel model referenced above
			// as the precise rounding is not exact but has no effect on the end result to 6 decimals.
			const expectedSupplyToMint = 160387922.86;
			const expectedNewTotalSupply = 260387922.86;
			assert.equal(mintableSupplyDecimal.toFixed(2), expectedSupplyToMint);
			assert.equal(newTotalSupplyDecimal.toFixed(2), expectedNewTotalSupply);

			assert.bnEqual(newTotalSupply, existingSupply.add(mintableSupply));
			assert.bnEqual(await oikos.balanceOf(RewardEscrow.address), expectedEscrowBalance);
		});

		it('should allow oikos contract to mint 2 weeks of supply and minus minterReward', async () => {
			// Issue
			const supplyToMint = toUnit(INITIAL_WEEKLY_SUPPLY * 2);

			// fast forward EVM to Week 3 in of the inflationary supply
			const weekThree = INFLATION_START_DATE + WEEK * 2 + DAY;
			await fastForwardTo(new Date(weekThree * 1000));
			await updateRatesWithDefaults({ oracle: oracle });

			const existingSupply = await oikos.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();
			const mintableSupplyDecimal = parseFloat(fromUnit(mintableSupply));
			const currentRewardEscrowBalance = await oikos.balanceOf(RewardEscrow.address);

			// call mint on Oikos
			await oikos.mint();

			const newTotalSupply = await oikos.totalSupply();
			const newTotalSupplyDecimal = parseFloat(fromUnit(newTotalSupply));

			const minterReward = await supplySchedule.minterReward();
			const expectedEscrowBalance = currentRewardEscrowBalance
				.add(mintableSupply)
				.sub(minterReward);

			// Here we are only checking to 2 decimal places from the excel model referenced above
			const expectedSupplyToMintDecimal = parseFloat(fromUnit(supplyToMint));
			const expectedNewTotalSupply = existingSupply.add(supplyToMint);
			const expectedNewTotalSupplyDecimal = parseFloat(fromUnit(expectedNewTotalSupply));
			assert.equal(mintableSupplyDecimal.toFixed(2), expectedSupplyToMintDecimal.toFixed(2));
			assert.equal(newTotalSupplyDecimal.toFixed(2), expectedNewTotalSupplyDecimal.toFixed(2));

			assert.bnEqual(newTotalSupply, existingSupply.add(mintableSupply));
			assert.bnEqual(await oikos.balanceOf(RewardEscrow.address), expectedEscrowBalance);
		});

		it('should allow oikos contract to mint the same supply for 39 weeks into the inflation prior to decay', async () => {
			// 39 weeks mimics the inflationary supply minted on mainnet
			const expectedTotalSupply = toUnit(1e8 + INITIAL_WEEKLY_SUPPLY * 39);
			const expectedSupplyToMint = toUnit(INITIAL_WEEKLY_SUPPLY * 39);

			// fast forward EVM to Week 2 in Year 3 schedule starting at UNIX 1583971200+
			const weekThirtyNine = INFLATION_START_DATE + WEEK * 39 + DAY;
			await fastForwardTo(new Date(weekThirtyNine * 1000));
			await updateRatesWithDefaults({ oracle: oracle });

			const existingTotalSupply = await oikos.totalSupply();
			const currentRewardEscrowBalance = await oikos.balanceOf(RewardEscrow.address);
			const mintableSupply = await supplySchedule.mintableSupply();

			// call mint on Oikos
			await oikos.mint();

			const newTotalSupply = await oikos.totalSupply();
			const minterReward = await supplySchedule.minterReward();
			const expectedEscrowBalance = currentRewardEscrowBalance
				.add(expectedSupplyToMint)
				.sub(minterReward);

			// The precision is slightly off using 18 wei. Matches mainnet.
			assert.bnClose(newTotalSupply, expectedTotalSupply, 27);
			assert.bnClose(mintableSupply, expectedSupplyToMint, 27);

			assert.bnClose(newTotalSupply, existingTotalSupply.add(expectedSupplyToMint), 27);
			assert.bnClose(await oikos.balanceOf(RewardEscrow.address), expectedEscrowBalance, 27);
		});

		it('should allow oikos contract to mint 2 weeks into Terminal Inflation', async () => {
			// fast forward EVM to week 236
			const september142023 = INFLATION_START_DATE + 236 * WEEK + DAY;
			await fastForwardTo(new Date(september142023 * 1000));
			await updateRatesWithDefaults({ oracle: oracle });

			const existingTotalSupply = await oikos.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();

			// call mint on Oikos
			await oikos.mint();

			const newTotalSupply = await oikos.totalSupply();

			const expectedTotalSupply = toUnit('260638356.052421715910204590');
			const expectedSupplyToMint = expectedTotalSupply.sub(existingTotalSupply);

			assert.bnEqual(newTotalSupply, existingTotalSupply.add(expectedSupplyToMint));
			assert.bnEqual(newTotalSupply, expectedTotalSupply);
			assert.bnEqual(mintableSupply, expectedSupplyToMint);
		});

		it('should allow oikos contract to mint Terminal Inflation to 2030', async () => {
			// fast forward EVM to week 236
			const week573 = INFLATION_START_DATE + 572 * WEEK + DAY;
			await fastForwardTo(new Date(week573 * 1000));
			await updateRatesWithDefaults({ oracle: oracle });

			const existingTotalSupply = await oikos.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();

			// call mint on Oikos
			await oikos.mint();

			const newTotalSupply = await oikos.totalSupply();

			const expectedTotalSupply = toUnit('306320971.934765774167963072');
			const expectedSupplyToMint = expectedTotalSupply.sub(existingTotalSupply);

			assert.bnEqual(newTotalSupply, existingTotalSupply.add(expectedSupplyToMint));
			assert.bnEqual(newTotalSupply, expectedTotalSupply);
			assert.bnEqual(mintableSupply, expectedSupplyToMint);
		});

		it('should be able to mint again after another 7 days period', async () => {
			// fast forward EVM to Week 3 in Year 2 schedule starting at UNIX 1553040000+
			const weekThree = INFLATION_START_DATE + 2 * WEEK + 1 * DAY;
			await fastForwardTo(new Date(weekThree * 1000));
			await updateRatesWithDefaults({ oracle: oracle });

			let existingTotalSupply = await oikos.totalSupply();
			let mintableSupply = await supplySchedule.mintableSupply();

			// call mint on Oikos
			await oikos.mint();

			let newTotalSupply = await oikos.totalSupply();
			assert.bnEqual(newTotalSupply, existingTotalSupply.add(mintableSupply));

			// fast forward EVM to Week 4
			const weekFour = weekThree + 1 * WEEK + 1 * DAY;
			await fastForwardTo(new Date(weekFour * 1000));
			await updateRatesWithDefaults({ oracle: oracle });

			existingTotalSupply = await oikos.totalSupply();
			mintableSupply = await supplySchedule.mintableSupply();

			// call mint on Oikos
			await oikos.mint();

			newTotalSupply = await oikos.totalSupply();
			assert.bnEqual(newTotalSupply, existingTotalSupply.add(mintableSupply));
		});

		it('should revert when trying to mint again within the 7 days period', async () => {
			// fast forward EVM to Week 3 of inflation
			const weekThree = INFLATION_START_DATE + 2 * WEEK + DAY;
			await fastForwardTo(new Date(weekThree * 1000));
			await updateRatesWithDefaults({ oracle: oracle });

			const existingTotalSupply = await oikos.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();

			// call mint on Oikos
			await oikos.mint();

			const newTotalSupply = await oikos.totalSupply();
			assert.bnEqual(newTotalSupply, existingTotalSupply.add(mintableSupply));

			const weekFour = weekThree + DAY * 1;
			await fastForwardTo(new Date(weekFour * 1000));

			// should revert if try to mint again within 7 day period / mintable supply is 0
			await assert.revert(oikos.mint(), 'No supply is mintable');
		});
	});

	describe('when etherCollateral is set', async () => {
		const collateralKey = 'EtherCollateral';

		let etherCollateral;
		beforeEach(async () => {
			etherCollateral = await EtherCollateral.at(
				await addressResolver.getAddress(toBytes32(collateralKey))
			);
		});
		it('should have zero totalIssuedSynths', async () => {
			// no synths issued in etherCollateral
			assert.bnEqual(0, await etherCollateral.totalIssuedSynths());

			// totalIssuedSynthsExcludeEtherCollateral equal totalIssuedSynths
			assert.bnEqual(
				await oikos.totalIssuedSynths(oUSD),
				await oikos.totalIssuedSynthsExcludeEtherCollateral(oUSD)
			);
		});
		describe('creating a loan on etherCollateral to issue oETH', async () => {
			let sETHContract;
			beforeEach(async () => {
				// mock etherCollateral
				etherCollateral = await MockEtherCollateral.new({ from: owner });
				// have the owner simulate being MultiCollateral so we can invoke issue and burn
				await addressResolver.importAddresses(
					[toBytes32(collateralKey)],
					[etherCollateral.address],
					{ from: owner }
				);

				sETHContract = await Synth.at(await oikos.synths(oETH));

				// Give some SNX to account1
				await oikos.transfer(account1, toUnit('1000'), { from: owner });

				// account1 should be able to issue
				await oikos.issueSynths(toUnit('10'), { from: account1 });

				// set owner as Oikos on resolver to allow issuing by owner
				await addressResolver.importAddresses([toBytes32('Oikos')], [owner], { from: owner });
			});

			it('should be able to exclude oETH issued by ether Collateral from totalIssuedSynths', async () => {
				const totalSupplyBefore = await oikos.totalIssuedSynths(oETH);

				// issue oETH
				const amountToIssue = toUnit('10');
				await sETHContract.issue(account1, amountToIssue, { from: owner });

				// openLoan of same amount on Ether Collateral
				await etherCollateral.openLoan(amountToIssue, { from: owner });

				// totalSupply of synths should exclude Ether Collateral issued synths
				assert.bnEqual(
					totalSupplyBefore,
					await oikos.totalIssuedSynthsExcludeEtherCollateral(oETH)
				);

				// totalIssuedSynths after includes amount issued
				assert.bnEqual(
					await oikos.totalIssuedSynths(oETH),
					totalSupplyBefore.add(amountToIssue)
				);
			});

			it('should exclude oETH issued by ether Collateral from debtBalanceOf', async () => {
				// account1 should own 100% of the debt.
				const debtBefore = await oikos.debtBalanceOf(account1, oUSD);
				assert.bnEqual(debtBefore, toUnit('10'));

				// issue oETH to mimic loan
				const amountToIssue = toUnit('10');
				await sETHContract.issue(account1, amountToIssue, { from: owner });
				await etherCollateral.openLoan(amountToIssue, { from: owner });

				// After account1 owns 100% of oUSD debt.
				assert.bnEqual(await oikos.totalIssuedSynthsExcludeEtherCollateral(oUSD), toUnit('10'));
				assert.bnEqual(await oikos.debtBalanceOf(account1, oUSD), debtBefore);
			});
		});
	});
});
