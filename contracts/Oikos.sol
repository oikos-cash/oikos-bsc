pragma solidity 0.4.25;

import "./ExternStateToken.sol";
import "./TokenState.sol";
import "./MixinResolver.sol";
import "./SupplySchedule.sol";
import "./Synth.sol";
import "./interfaces/IOikosState.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IOikosEscrow.sol";
import "./interfaces/IFeePool.sol";
import "./interfaces/IRewardsDistribution.sol";
import "./interfaces/IExchanger.sol";
import "./interfaces/IIssuer.sol";
import "./interfaces/IBNBCollateral.sol";


/**
 * @title Oikos ERC20 contract.
 * @notice The Oikos contracts not only facilitates transfers, exchanges, and tracks balances,
 * but it also computes the quantity of fees each oikos holder is entitled to.
 */
contract Oikos is ExternStateToken, MixinResolver {
    // ========== STATE VARIABLES ==========

    // Available Synths which can be used with the system
    Synth[] public availableSynths;
    mapping(bytes32 => Synth) public synths;
    mapping(address => bytes32) public synthsByAddress;

    string constant TOKEN_NAME = "Oikos Network Token";
    string constant TOKEN_SYMBOL = "OKS";
    uint8 constant DECIMALS = 18;
    bytes32 constant oUSD = "oUSD";

    // ========== CONSTRUCTOR ==========

    /**
     * @dev Constructor
     * @param _proxy The main token address of the Proxy contract. This will be ProxyERC20.sol
     * @param _tokenState Address of the external immutable contract containing token balances.
     * @param _owner The owner of this contract.
     * @param _totalSupply On upgrading set to reestablish the current total supply (This should be in OikosState if ever updated)
     * @param _resolver The address of the Oikos Address Resolver
     */
    constructor(address _proxy, TokenState _tokenState, address _owner, uint _totalSupply, address _resolver)
        public
        ExternStateToken(_proxy, _tokenState, TOKEN_NAME, TOKEN_SYMBOL, _totalSupply, DECIMALS, _owner)
        MixinResolver(_owner, _resolver)
    {}

    /* ========== VIEWS ========== */

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(resolver.requireAndGetAddress("Exchanger", "Missing Exchanger address"));
    }

    function bnbCollateral() internal view returns (IBNBCollateral) {
        return IBNBCollateral(resolver.requireAndGetAddress("BNBCollateral", "Missing BNBCollateral address"));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(resolver.requireAndGetAddress("Issuer", "Missing Issuer address"));
    }

    function oikosState() internal view returns (IOikosState) {
        return IOikosState(resolver.requireAndGetAddress("OikosState", "Missing OikosState address"));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(resolver.requireAndGetAddress("ExchangeRates", "Missing ExchangeRates address"));
    }

    function feePool() internal view returns (IFeePool) {
        return IFeePool(resolver.requireAndGetAddress("FeePool", "Missing FeePool address"));
    }

    function supplySchedule() internal view returns (SupplySchedule) {
        return SupplySchedule(resolver.requireAndGetAddress("SupplySchedule", "Missing SupplySchedule address"));
    }

    function rewardEscrow() internal view returns (IOikosEscrow) {
        return IOikosEscrow(resolver.requireAndGetAddress("RewardEscrow", "Missing RewardEscrow address"));
    }

    function oikosEscrow() internal view returns (IOikosEscrow) {
        return IOikosEscrow(resolver.requireAndGetAddress("OikosEscrow", "Missing OikosEscrow address"));
    }

    function rewardsDistribution() internal view returns (IRewardsDistribution) {
        return
            IRewardsDistribution(
                resolver.requireAndGetAddress("RewardsDistribution", "Missing RewardsDistribution address")
            );
    }

    /**
     * @notice Total amount of synths issued by the system, priced in currencyKey
     * @param currencyKey The currency to value the synths in
     */
    function _totalIssuedSynths(bytes32 currencyKey, bool excludeBNBCollateral) internal view returns (uint) {
        IExchangeRates exRates = exchangeRates();
        uint total = 0;
        uint currencyRate = exRates.rateForCurrency(currencyKey);

        (uint[] memory rates, bool anyRateStale) = exRates.ratesAndStaleForCurrencies(availableCurrencyKeys());
        require(!anyRateStale, "Rates are stale");

        for (uint i = 0; i < availableSynths.length; i++) {
            // What's the total issued value of that synth in the destination currency?
            // Note: We're not using exchangeRates().effectiveValue() because we don't want to go get the
            //       rate for the destination currency and check if it's stale repeatedly on every
            //       iteration of the loop
            uint totalSynths = availableSynths[i].totalSupply();

            // minus total issued synths from BNBCollateral from oBNB.totalSupply()
            if (excludeBNBCollateral && availableSynths[i] == synths["oBNB"]) {
                totalSynths = totalSynths.sub(bnbCollateral().totalIssuedSynths());
            }

            uint synthValue = totalSynths.multiplyDecimalRound(rates[i]);
            total = total.add(synthValue);
        }

        return total.divideDecimalRound(currencyRate);
    }

    /**
     * @notice Total amount of synths issued by the system priced in currencyKey
     * @param currencyKey The currency to value the synths in
     */
    function totalIssuedSynths(bytes32 currencyKey) public view returns (uint) {
        return _totalIssuedSynths(currencyKey, false);
    }

    /**
     * @notice Total amount of synths issued by the system priced in currencyKey, excluding ether collateral
     * @param currencyKey The currency to value the synths in
     */
    function totalIssuedSynthsExcludeBNBCollateral(bytes32 currencyKey) public view returns (uint) {
        return _totalIssuedSynths(currencyKey, true);
    }

    /**
     * @notice Returns the currencyKeys of availableSynths for rate checking
     */
    function availableCurrencyKeys() public view returns (bytes32[]) {
        bytes32[] memory currencyKeys = new bytes32[](availableSynths.length);

        for (uint i = 0; i < availableSynths.length; i++) {
            currencyKeys[i] = synthsByAddress[availableSynths[i]];
        }

        return currencyKeys;
    }

    /**
     * @notice Returns the count of available synths in the system, which you can use to iterate availableSynths
     */
    function availableSynthCount() public view returns (uint) {
        return availableSynths.length;
    }

    function isWaitingPeriod(bytes32 currencyKey) external view returns (bool) {
        return exchanger().maxSecsLeftInWaitingPeriod(messageSender, currencyKey) > 0;
    }

    // ========== MUTATIVE FUNCTIONS ==========

    /**
     * @notice Add an associated Synth contract to the Oikos system
     * @dev Only the contract owner may call this.
     */
    function addSynth(Synth synth) external optionalProxy_onlyOwner {
        bytes32 currencyKey = synth.currencyKey();

        require(synths[currencyKey] == Synth(0), "Synth already exists");
        require(synthsByAddress[synth] == bytes32(0), "Synth address already exists");

        availableSynths.push(synth);
        synths[currencyKey] = synth;
        synthsByAddress[synth] = currencyKey;
    }

    /**
     * @notice Remove an associated Synth contract from the Oikos system
     * @dev Only the contract owner may call this.
     */
    function removeSynth(bytes32 currencyKey) external optionalProxy_onlyOwner {
        require(synths[currencyKey] != address(0), "Synth does not exist");
        require(synths[currencyKey].totalSupply() == 0, "Synth supply exists");
        require(currencyKey != oUSD, "Cannot remove synth");

        // Save the address we're removing for emitting the event at the end.
        address synthToRemove = synths[currencyKey];

        // Remove the synth from the availableSynths array.
        for (uint i = 0; i < availableSynths.length; i++) {
            if (availableSynths[i] == synthToRemove) {
                delete availableSynths[i];

                // Copy the last synth into the place of the one we just deleted
                // If there's only one synth, this is synths[0] = synths[0].
                // If we're deleting the last one, it's also a NOOP in the same way.
                availableSynths[i] = availableSynths[availableSynths.length - 1];

                // Decrease the size of the array by one.
                availableSynths.length--;

                break;
            }
        }

        // And remove it from the synths mapping
        delete synthsByAddress[synths[currencyKey]];
        delete synths[currencyKey];

        // Note: No event here as Oikos contract exceeds max contract size
        // with these events, and it's unlikely people will need to
        // track these events specifically.
    }

    /**
     * @notice ERC20 transfer function.
     */
    function transfer(address to, uint value) public optionalProxy returns (bool) {
        // Ensure they're not trying to exceed their staked OKS amount
        require(value <= transferableOikos(messageSender), "Cannot transfer staked or escrowed OKS");

        // Perform the transfer: if there is a problem an exception will be thrown in this call.
        _transfer_byProxy(messageSender, to, value);

        return true;
    }

    /**
     * @notice ERC20 transferFrom function.
     */
    function transferFrom(address from, address to, uint value) public optionalProxy returns (bool) {
        // Ensure they're not trying to exceed their locked amount
        require(value <= transferableOikos(from), "Cannot transfer staked or escrowed OKS");

        // Perform the transfer: if there is a problem,
        // an exception will be thrown in this call.
        return _transferFrom_byProxy(messageSender, from, to, value);
    }

    function issueSynths(uint amount) external optionalProxy {
        return issuer().issueSynths(messageSender, amount);
    }

    function issueMaxSynths() external optionalProxy {
        return issuer().issueMaxSynths(messageSender);
    }

    function burnSynths(uint amount) external optionalProxy {
        return issuer().burnSynths(messageSender, amount);
    }

    function burnSynthsToTarget() external optionalProxy {
        return issuer().burnSynthsToTarget(messageSender);
    }

    function exchange(bytes32 sourceCurrencyKey, uint sourceAmount, bytes32 destinationCurrencyKey)
        external
        optionalProxy
        returns (uint amountReceived)
    {
        return exchanger().exchange(messageSender, sourceCurrencyKey, sourceAmount, destinationCurrencyKey, messageSender);
    }

    function settle(bytes32 currencyKey) external optionalProxy returns (uint reclaimed, uint refunded) {
        return exchanger().settle(messageSender, currencyKey);
    }

    // ========== Issuance/Burning ==========

    /**
     * @notice The maximum synths an issuer can issue against their total oikos quantity.
     * This ignores any already issued synths, and is purely giving you the maximimum amount the user can issue.
     */
    function maxIssuableSynths(address _issuer)
        public
        view
        returns (
            // We don't need to check stale rates here as effectiveValue will do it for us.
            uint
        )
    {
        // What is the value of their OKS balance in the destination currency?
        uint destinationValue = exchangeRates().effectiveValue("OKS", collateral(_issuer), oUSD);

        // They're allowed to issue up to issuanceRatio of that value
        return destinationValue.multiplyDecimal(oikosState().issuanceRatio());
    }

    /**
     * @notice The current collateralisation ratio for a user. Collateralisation ratio varies over time
     * as the value of the underlying Oikos asset changes,
     * e.g. based on an issuance ratio of 20%. if a user issues their maximum available
     * synths when they hold $10 worth of Oikos, they will have issued $2 worth of synths. If the value
     * of Oikos changes, the ratio returned by this function will adjust accordingly. Users are
     * incentivised to maintain a collateralisation ratio as close to the issuance ratio as possible by
     * altering the amount of fees they're able to claim from the system.
     */
    function collateralisationRatio(address _issuer) public view returns (uint) {
        uint totalOwnedOikos = collateral(_issuer);
        if (totalOwnedOikos == 0) return 0;

        uint debtBalance = debtBalanceOf(_issuer, "OKS");
        return debtBalance.divideDecimalRound(totalOwnedOikos);
    }

    /**
     * @notice If a user issues synths backed by OKS in their wallet, the OKS become locked. This function
     * will tell you how many synths a user has to give back to the system in order to unlock their original
     * debt position. This is priced in whichever synth is passed in as a currency key, e.g. you can price
     * the debt in oUSD, or any other synth you wish.
     */
    function debtBalanceOf(address _issuer, bytes32 currencyKey)
        public
        view
        returns (
            // Don't need to check for stale rates here because totalIssuedSynths will do it for us
            uint
        )
    {
        IOikosState state = oikosState();

        // What was their initial debt ownership?
        (uint initialDebtOwnership, ) = state.issuanceData(_issuer);

        // If it's zero, they haven't issued, and they have no debt.
        if (initialDebtOwnership == 0) return 0;

        (uint debtBalance, ) = debtBalanceOfAndTotalDebt(_issuer, currencyKey);
        return debtBalance;
    }

    function debtBalanceOfAndTotalDebt(address _issuer, bytes32 currencyKey)
        public
        view
        returns (
            uint debtBalance,
            uint totalSystemValue
        )
    {
        IOikosState state = oikosState();

        // What was their initial debt ownership?
        uint initialDebtOwnership;
        uint debtEntryIndex;
        (initialDebtOwnership, debtEntryIndex) = state.issuanceData(_issuer);

        // What's the total value of the system excluding ETH backed synths in their requested currency?
        totalSystemValue = totalIssuedSynthsExcludeBNBCollateral(currencyKey);

        // If it's zero, they haven't issued, and they have no debt.
        if (initialDebtOwnership == 0) return (0, totalSystemValue);

        // Figure out the global debt percentage delta from when they entered the system.
        // This is a high precision integer of 27 (1e27) decimals.
        uint currentDebtOwnership = state
            .lastDebtLedgerEntry()
            .divideDecimalRoundPrecise(state.debtLedger(debtEntryIndex))
            .multiplyDecimalRoundPrecise(initialDebtOwnership);

        // Their debt balance is their portion of the total system value.
        uint highPrecisionBalance = totalSystemValue.decimalToPreciseDecimal().multiplyDecimalRoundPrecise(
            currentDebtOwnership
        );

        // Convert back into 18 decimals (1e18)
        debtBalance = highPrecisionBalance.preciseDecimalToDecimal();
    }

    /**
     * @notice The remaining synths an issuer can issue against their total oikos balance.
     * @param _issuer The account that intends to issue
     */
    function remainingIssuableSynths(address _issuer)
        public
        view
        returns (
            // Don't need to check for synth existing or stale rates because maxIssuableSynths will do it for us.
            uint maxIssuable,
            uint alreadyIssued,
            uint totalSystemDebt
        )
    {
        (alreadyIssued, totalSystemDebt) = debtBalanceOfAndTotalDebt(_issuer, oUSD);
        maxIssuable = maxIssuableSynths(_issuer);

        if (alreadyIssued >= maxIssuable) {
            maxIssuable = 0;
        } else {
            maxIssuable = maxIssuable.sub(alreadyIssued);
        }
    }

    /**
     * @notice The total OKS owned by this account, both escrowed and unescrowed,
     * against which synths can be issued.
     * This includes those already being used as collateral (locked), and those
     * available for further issuance (unlocked).
     */
    function collateral(address account) public view returns (uint) {
        uint balance = tokenState.balanceOf(account);

        if (oikosEscrow() != address(0)) {
            balance = balance.add(oikosEscrow().balanceOf(account));
        }

        if (rewardEscrow() != address(0)) {
            balance = balance.add(rewardEscrow().balanceOf(account));
        }

        return balance;
    }

    /**
     * @notice The number of OKS that are free to be transferred for an account.
     * @dev Escrowed OKS are not transferable, so they are not included
     * in this calculation.
     * @notice OKS rate not stale is checked within debtBalanceOf
     */
    function transferableOikos(address account)
        public
        view
        rateNotStale("OKS") // OKS is not a synth so is not checked in totalIssuedSynths
        returns (uint)
    {
        // How many OKS do they have, excluding escrow?
        // Note: We're excluding escrow here because we're interested in their transferable amount
        // and escrowed OKS are not transferable.
        uint balance = tokenState.balanceOf(account);

        // How many of those will be locked by the amount they've issued?
        // Assuming issuance ratio is 20%, then issuing 20 OKS of value would require
        // 100 OKS to be locked in their wallet to maintain their collateralisation ratio
        // The locked oikos value can exceed their balance.
        uint lockedOikosValue = debtBalanceOf(account, "OKS").divideDecimalRound(oikosState().issuanceRatio());

        // If we exceed the balance, no OKS are transferable, otherwise the difference is.
        if (lockedOikosValue >= balance) {
            return 0;
        } else {
            return balance.sub(lockedOikosValue);
        }
    }

    /**
     * @notice Mints the inflationary OKS supply. The inflation shedule is
     * defined in the SupplySchedule contract.
     * The mint() function is publicly callable by anyone. The caller will
     receive a minter reward as specified in supplySchedule.minterReward().
     */
    function mint() external returns (bool) {
        require(rewardsDistribution() != address(0), "RewardsDistribution not set");

        SupplySchedule _supplySchedule = supplySchedule();
        IRewardsDistribution _rewardsDistribution = rewardsDistribution();

        uint supplyToMint = _supplySchedule.mintableSupply();
        require(supplyToMint > 0, "No supply is mintable");

        // record minting event before mutation to token supply
        _supplySchedule.recordMintEvent(supplyToMint);

        // Set minted OKS balance to RewardEscrow's balance
        // Minus the minterReward and set balance of minter to add reward
        uint minterReward = _supplySchedule.minterReward();
        // Get the remainder
        uint amountToDistribute = supplyToMint.sub(minterReward);

        // Set the token balance to the RewardsDistribution contract
        tokenState.setBalanceOf(_rewardsDistribution, tokenState.balanceOf(_rewardsDistribution).add(amountToDistribute));
        emitTransfer(this, _rewardsDistribution, amountToDistribute);

        // Kick off the distribution of rewards
        _rewardsDistribution.distributeRewards(amountToDistribute);

        // Assign the minters reward.
        tokenState.setBalanceOf(msg.sender, tokenState.balanceOf(msg.sender).add(minterReward));
        emitTransfer(this, msg.sender, minterReward);

        totalSupply = totalSupply.add(supplyToMint);

        return true;
    }

    // ========== MODIFIERS ==========

    modifier rateNotStale(bytes32 currencyKey) {
        require(!exchangeRates().rateIsStale(currencyKey), "Rate stale or not a synth");
        _;
    }

    modifier onlyExchanger() {
        require(msg.sender == address(exchanger()), "Only the exchanger contract can invoke this function");
        _;
    }

    // ========== EVENTS ==========
    /* solium-disable */
    event SynthExchange(
        address indexed account,
        bytes32 fromCurrencyKey,
        uint256 fromAmount,
        bytes32 toCurrencyKey,
        uint256 toAmount,
        address toAddress
    );
    bytes32 constant SYNTHEXCHANGE_SIG = keccak256("SynthExchange(address,bytes32,uint256,bytes32,uint256,address)");

    function emitSynthExchange(
        address account,
        bytes32 fromCurrencyKey,
        uint256 fromAmount,
        bytes32 toCurrencyKey,
        uint256 toAmount,
        address toAddress
    ) external onlyExchanger {
        proxy._emit(
            abi.encode(fromCurrencyKey, fromAmount, toCurrencyKey, toAmount, toAddress),
            2,
            SYNTHEXCHANGE_SIG,
            bytes32(account),
            0,
            0
        );
    }

    event ExchangeReclaim(address indexed account, bytes32 currencyKey, uint amount);
    bytes32 constant EXCHANGERECLAIM_SIG = keccak256("ExchangeReclaim(address,bytes32,uint256)");

    function emitExchangeReclaim(address account, bytes32 currencyKey, uint256 amount) external onlyExchanger {
        proxy._emit(abi.encode(currencyKey, amount), 2, EXCHANGERECLAIM_SIG, bytes32(account), 0, 0);
    }

    event ExchangeRebate(address indexed account, bytes32 currencyKey, uint amount);
    bytes32 constant EXCHANGEREBATE_SIG = keccak256("ExchangeRebate(address,bytes32,uint256)");

    function emitExchangeRebate(address account, bytes32 currencyKey, uint256 amount) external onlyExchanger {
        proxy._emit(abi.encode(currencyKey, amount), 2, EXCHANGEREBATE_SIG, bytes32(account), 0, 0);
    }
    /* solium-enable */
}
