pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./Proxyable.sol";
import "./SelfDestructible.sol";
import "./LimitedSetup.sol";
import "./MixinResolver.sol";
import "./interfaces/IFeePool.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/IERC20.sol";
import "./interfaces/ISynth.sol";
import "./interfaces/ISystemStatus.sol";
import "./interfaces/IOikos.sol";
import "./FeePoolState.sol";
import "./FeePoolEternalStorage.sol";
import "./interfaces/IExchanger.sol";
import "./interfaces/IIssuer.sol";
import "./interfaces/IOikosState.sol";
import "./interfaces/IRewardEscrow.sol";
import "./interfaces/IDelegateApprovals.sol";
import "./interfaces/IRewardsDistribution.sol";


// https://docs.oikos.cash/contracts/FeePool
contract FeePool is Owned, Proxyable, SelfDestructible, LimitedSetup, MixinResolver, IFeePool {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    // Exchange fee may not exceed 10%.
    uint public constant MAX_EXCHANGE_FEE_RATE = 1e18 / 10;

    // Where fees are pooled in oUSD.
    address public constant FEE_ADDRESS = 0xfeEFEEfeefEeFeefEEFEEfEeFeefEEFeeFEEFEeF;

    // oUSD currencyKey. Fees stored and paid in oUSD
    bytes32 private oUSD = "oUSD";

    // This struct represents the issuance activity that's happened in a fee period.
    struct FeePeriod {
        uint64 feePeriodId;
        uint64 startingDebtIndex;
        uint64 startTime;
        uint feesToDistribute;
        uint feesClaimed;
        uint rewardsToDistribute;
        uint rewardsClaimed;
    }

    // A staker(mintr) can claim from the previous fee period (7 days) only.
    // Fee Periods stored and managed from [0], such that [0] is always
    // the current active fee period which is not claimable until the
    // public function closeCurrentFeePeriod() is called closing the
    // current weeks collected fees. [1] is last weeks feeperiod
    uint8 public constant FEE_PERIOD_LENGTH = 2;

    FeePeriod[FEE_PERIOD_LENGTH] private _recentFeePeriods;
    uint256 private _currentFeePeriod;

    // How long a fee period lasts at a minimum. It is required for
    // anyone to roll over the periods, so they are not guaranteed
    // to roll over at exactly this duration, but the contract enforces
    // that they cannot roll over any quicker than this duration.
    uint public feePeriodDuration = 1 weeks;
    // The fee period must be between 1 day and 60 days.
    uint public constant MIN_FEE_PERIOD_DURATION = 1 days;
    uint public constant MAX_FEE_PERIOD_DURATION = 60 days;

    // Users are unable to claim fees if their collateralisation ratio drifts out of target treshold
    uint public targetThreshold = (1 * SafeDecimalMath.unit()) / 100;

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_SYSTEMSTATUS = "SystemStatus";
    bytes32 private constant CONTRACT_OIKOS = "Oikos";
    bytes32 private constant CONTRACT_FEEPOOLSTATE = "FeePoolState";
    bytes32 private constant CONTRACT_FEEPOOLETERNALSTORAGE = "FeePoolEternalStorage";
    bytes32 private constant CONTRACT_EXCHANGER = "Exchanger";
    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_OIKOSSTATE = "OikosState";
    bytes32 private constant CONTRACT_REWARDESCROW = "RewardEscrow";
    bytes32 private constant CONTRACT_DELEGATEAPPROVALS = "DelegateApprovals";
    bytes32 private constant CONTRACT_REWARDSDISTRIBUTION = "RewardsDistribution";

    bytes32[24] private addressesToCache = [
        CONTRACT_SYSTEMSTATUS,
        CONTRACT_OIKOS,
        CONTRACT_FEEPOOLSTATE,
        CONTRACT_FEEPOOLETERNALSTORAGE,
        CONTRACT_EXCHANGER,
        CONTRACT_ISSUER,
        CONTRACT_OIKOSSTATE,
        CONTRACT_REWARDESCROW,
        CONTRACT_DELEGATEAPPROVALS,
        CONTRACT_REWARDSDISTRIBUTION
    ];

    /* ========== ETERNAL STORAGE CONSTANTS ========== */

    bytes32 private constant LAST_FEE_WITHDRAWAL = "last_fee_withdrawal";
    bytes32 private constant SYNTH_EXCHANGE_FEE_RATE = "synth_exchange_fee_rate";

    constructor(
        address payable _proxy,
        address _owner,
        address _resolver
    )
        public
        Owned(_owner)
        SelfDestructible()
        Proxyable(_proxy)
        LimitedSetup(3 weeks)
        MixinResolver(_resolver, addressesToCache)
    {
        // Set our initial fee period
        _recentFeePeriodsStorage(0).feePeriodId = 1;
        _recentFeePeriodsStorage(0).startTime = uint64(now);
    }

    /* ========== VIEWS ========== */

    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(resolver.requireAndGetAddress(CONTRACT_SYSTEMSTATUS, "Missing SystemStatus address"));
    }

    function oikos() internal view returns (IOikos) {
        return IOikos(resolver.requireAndGetAddress(CONTRACT_OIKOS, "Missing Oikos address"));
    }

    function feePoolState() internal view returns (FeePoolState) {
        return FeePoolState(resolver.requireAndGetAddress(CONTRACT_FEEPOOLSTATE, "Missing FeePoolState address"));
    }

    function feePoolEternalStorage() internal view returns (FeePoolEternalStorage) {
        return
            FeePoolEternalStorage(
                resolver.requireAndGetAddress(CONTRACT_FEEPOOLETERNALSTORAGE, "Missing FeePoolEternalStorage address")
            );
    }

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(resolver.requireAndGetAddress(CONTRACT_EXCHANGER, "Missing Exchanger address"));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(resolver.requireAndGetAddress(CONTRACT_ISSUER, "Missing Issuer address"));
    }

    function oikosState() internal view returns (IOikosState) {
        return IOikosState(resolver.requireAndGetAddress(CONTRACT_OIKOSSTATE, "Missing OikosState address"));
    }

    function rewardEscrow() internal view returns (IRewardEscrow) {
        return IRewardEscrow(resolver.requireAndGetAddress(CONTRACT_REWARDESCROW, "Missing RewardEscrow address"));
    }

    function delegateApprovals() internal view returns (IDelegateApprovals) {
        return IDelegateApprovals(resolver.requireAndGetAddress(CONTRACT_DELEGATEAPPROVALS, "Missing DelegateApprovals address"));
    }

    function rewardsDistribution() internal view returns (IRewardsDistribution) {
        return
            IRewardsDistribution(resolver.requireAndGetAddress(CONTRACT_REWARDSDISTRIBUTION, "Missing RewardsDistribution address"));
    }

    function recentFeePeriods(uint index)
        external
        view
        returns (
            uint64 feePeriodId,
            uint64 startingDebtIndex,
            uint64 startTime,
            uint feesToDistribute,
            uint feesClaimed,
            uint rewardsToDistribute,
            uint rewardsClaimed
        )
    {
        FeePeriod memory feePeriod = _recentFeePeriodsStorage(index);
        return (
            feePeriod.feePeriodId,
            feePeriod.startingDebtIndex,
            feePeriod.startTime,
            feePeriod.feesToDistribute,
            feePeriod.feesClaimed,
            feePeriod.rewardsToDistribute,
            feePeriod.rewardsClaimed
        );
    }

    function _recentFeePeriodsStorage(uint index) internal view returns (FeePeriod storage) {
        return _recentFeePeriods[(_currentFeePeriod + index) % FEE_PERIOD_LENGTH];
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    /**
     * @notice Logs an accounts issuance data per fee period
     * @param account Message.Senders account address
     * @param debtRatio Debt percentage this account has locked after minting or burning their synth
     * @param debtEntryIndex The index in the global debt ledger. oikosState.issuanceData(account)
     * @dev onlyIssuer to call me on oikos.issue() & oikos.burn() calls to store the locked OKS
     * per fee period so we know to allocate the correct proportions of fees and rewards per period
     */
    function appendAccountIssuanceRecord(
        address account,
        uint debtRatio,
        uint debtEntryIndex
    ) external onlyIssuer {
        feePoolState().appendAccountIssuanceRecord(
            account,
            debtRatio,
            debtEntryIndex,
            _recentFeePeriodsStorage(0).startingDebtIndex
        );

        emitIssuanceDebtRatioEntry(account, debtRatio, debtEntryIndex, _recentFeePeriodsStorage(0).startingDebtIndex);
    }

    /**
     * @notice Set the fee period duration
     */
    function setFeePeriodDuration(uint _feePeriodDuration) external optionalProxy_onlyOwner {
        require(_feePeriodDuration >= MIN_FEE_PERIOD_DURATION, "value < MIN_FEE_PERIOD_DURATION");
        require(_feePeriodDuration <= MAX_FEE_PERIOD_DURATION, "value > MAX_FEE_PERIOD_DURATION");

        feePeriodDuration = _feePeriodDuration;

        emitFeePeriodDurationUpdated(_feePeriodDuration);
    }

    function setTargetThreshold(uint _percent) external optionalProxy_onlyOwner {
        require(_percent <= 50, "Threshold too high");
        targetThreshold = _percent.mul(SafeDecimalMath.unit()).div(100);
    }

    /**
     * @notice The Exchanger contract informs us when fees are paid.
     * @param amount susd amount in fees being paid.
     */
    function recordFeePaid(uint amount) external onlyExchangerOrSynth {
        // Keep track off fees in oUSD in the open fee pool period.
        _recentFeePeriodsStorage(0).feesToDistribute = _recentFeePeriodsStorage(0).feesToDistribute.add(amount);
    }

    /**
     * @notice The RewardsDistribution contract informs us how many OKS rewards are sent to RewardEscrow to be claimed.
     */
    function setRewardsToDistribute(uint amount) external {
        address rewardsAuthority = address(rewardsDistribution());
        require(messageSender == rewardsAuthority || msg.sender == rewardsAuthority, "Caller is not rewardsAuthority");
        // Add the amount of OKS rewards to distribute on top of any rolling unclaimed amount
        _recentFeePeriodsStorage(0).rewardsToDistribute = _recentFeePeriodsStorage(0).rewardsToDistribute.add(amount);
    }

    /**
     * @notice Close the current fee period and start a new one.
     */
    function closeCurrentFeePeriod() external issuanceActive {
        require(_recentFeePeriodsStorage(0).startTime <= (now - feePeriodDuration), "Too early to close fee period");

        // Note:  when FEE_PERIOD_LENGTH = 2, periodClosing is the current period & periodToRollover is the last open claimable period
        FeePeriod storage periodClosing = _recentFeePeriodsStorage(FEE_PERIOD_LENGTH - 2);
        FeePeriod storage periodToRollover = _recentFeePeriodsStorage(FEE_PERIOD_LENGTH - 1);

        // Any unclaimed fees from the last period in the array roll back one period.
        // Because of the subtraction here, they're effectively proportionally redistributed to those who
        // have already claimed from the old period, available in the new period.
        // The subtraction is important so we don't create a ticking time bomb of an ever growing
        // number of fees that can never decrease and will eventually overflow at the end of the fee pool.
        _recentFeePeriodsStorage(FEE_PERIOD_LENGTH - 2).feesToDistribute = periodToRollover
            .feesToDistribute
            .sub(periodToRollover.feesClaimed)
            .add(periodClosing.feesToDistribute);
        _recentFeePeriodsStorage(FEE_PERIOD_LENGTH - 2).rewardsToDistribute = periodToRollover
            .rewardsToDistribute
            .sub(periodToRollover.rewardsClaimed)
            .add(periodClosing.rewardsToDistribute);

        // Shift the previous fee periods across to make room for the new one.
        _currentFeePeriod = _currentFeePeriod.add(FEE_PERIOD_LENGTH).sub(1).mod(FEE_PERIOD_LENGTH);

        // Clear the first element of the array to make sure we don't have any stale values.
        delete _recentFeePeriods[_currentFeePeriod];

        // Open up the new fee period.
        // Increment periodId from the recent closed period feePeriodId
        _recentFeePeriodsStorage(0).feePeriodId = uint64(uint256(_recentFeePeriodsStorage(1).feePeriodId).add(1));
        _recentFeePeriodsStorage(0).startingDebtIndex = uint64(oikosState().debtLedgerLength());
        _recentFeePeriodsStorage(0).startTime = uint64(now);

        emitFeePeriodClosed(_recentFeePeriodsStorage(1).feePeriodId);
    }

    /**
     * @notice Claim fees for last period when available or not already withdrawn.
     */
    function claimFees() external issuanceActive optionalProxy returns (bool) {
        return _claimFees(messageSender);
    }

    /**
     * @notice Delegated claimFees(). Call from the deletegated address
     * and the fees will be sent to the claimingForAddress.
     * approveClaimOnBehalf() must be called first to approve the deletage address
     * @param claimingForAddress The account you are claiming fees for
     */
    function claimOnBehalf(address claimingForAddress) external issuanceActive optionalProxy returns (bool) {
        require(delegateApprovals().canClaimFor(claimingForAddress, messageSender), "Not approved to claim on behalf");

        return _claimFees(claimingForAddress);
    }

    function _claimFees(address claimingAddress) internal returns (bool) {
        uint rewardsPaid = 0;
        uint feesPaid = 0;
        uint availableFees;
        uint availableRewards;

        // Address won't be able to claim fees if it is too far below the target c-ratio.
        // It will need to burn synths then try claiming again.
        (bool feesClaimable, bool anyRateIsStale) = _isFeesClaimableAndAnyRatesStale(claimingAddress);

        require(feesClaimable, "C-Ratio below penalty threshold");

        require(!anyRateIsStale, "A synth or OKS rate is stale");

        // Get the claimingAddress available fees and rewards
        (availableFees, availableRewards) = feesAvailable(claimingAddress);

        require(
            availableFees > 0 || availableRewards > 0,
            "No fees or rewards available for period, or fees already claimed"
        );

        // Record the address has claimed for this period
        _setLastFeeWithdrawal(claimingAddress, _recentFeePeriodsStorage(1).feePeriodId);

        if (availableFees > 0) {
            // Record the fee payment in our recentFeePeriods
            feesPaid = _recordFeePayment(availableFees);

            // Send them their fees
            _payFees(claimingAddress, feesPaid);
        }

        if (availableRewards > 0) {
            // Record the reward payment in our recentFeePeriods
            rewardsPaid = _recordRewardPayment(availableRewards);

            // Send them their rewards
            _payRewards(claimingAddress, rewardsPaid);
        }

        emitFeesClaimed(claimingAddress, feesPaid, rewardsPaid);

        return true;
    }

    /**
     * @notice Admin function to import the FeePeriod data from the previous contract
     */
    function importFeePeriod(
        uint feePeriodIndex,
        uint feePeriodId,
        uint startingDebtIndex,
        uint startTime,
        uint feesToDistribute,
        uint feesClaimed,
        uint rewardsToDistribute,
        uint rewardsClaimed
    ) public optionalProxy_onlyOwner onlyDuringSetup {
        require(startingDebtIndex <= oikosState().debtLedgerLength(), "Cannot import bad data");

        _recentFeePeriods[_currentFeePeriod.add(feePeriodIndex).mod(FEE_PERIOD_LENGTH)] = FeePeriod({
            feePeriodId: uint64(feePeriodId),
            startingDebtIndex: uint64(startingDebtIndex),
            startTime: uint64(startTime),
            feesToDistribute: feesToDistribute,
            feesClaimed: feesClaimed,
            rewardsToDistribute: rewardsToDistribute,
            rewardsClaimed: rewardsClaimed
        });
    }

    function setExchangeFeeRateForSynths(bytes32[] calldata synthKeys, uint256[] calldata exchangeFeeRates) external optionalProxy_onlyOwner
    {
        require(synthKeys.length == exchangeFeeRates.length, "Array lengths dont match");
        for (uint i = 0; i < synthKeys.length; i++) {
            require(exchangeFeeRates[i] <= MAX_EXCHANGE_FEE_RATE, "MAX_EXCHANGE_FEE_RATE exceeded");
            feePoolEternalStorage().setUIntValue(
                keccak256(abi.encodePacked(SYNTH_EXCHANGE_FEE_RATE, synthKeys[i])),
                exchangeFeeRates[i]
            );
            emitExchangeFeeUpdated(synthKeys[i], exchangeFeeRates[i]);
        }
    }

    function getExchangeFeeRateForSynth(bytes32 synthKey) external view returns (uint exchangeFeeRate) {
        exchangeFeeRate = feePoolEternalStorage().getUIntValue(
            keccak256(abi.encodePacked(SYNTH_EXCHANGE_FEE_RATE, synthKey))
        );
    }

    /**
     * @notice Owner can escrow OKS. Owner to send the tokens to the RewardEscrow
     * @param account Address to escrow tokens for
     * @param quantity Amount of tokens to escrow
     */
    function appendVestingEntry(address account, uint quantity) public optionalProxy_onlyOwner {
        // Transfer OKS from messageSender to the Reward Escrow
        IERC20(address(oikos())).transferFrom(messageSender, address(rewardEscrow()), quantity);

        // Create Vesting Entry
        rewardEscrow().appendVestingEntry(account, quantity);
    }

    /**
     * @notice Record the fee payment in our recentFeePeriods.
     * @param oUSDAmount The amount of fees priced in oUSD.
     */
    function _recordFeePayment(uint oUSDAmount) internal returns (uint) {
        // Don't assign to the parameter
        uint remainingToAllocate = oUSDAmount;

        uint feesPaid;
        // Start at the oldest period and record the amount, moving to newer periods
        // until we've exhausted the amount.
        // The condition checks for overflow because we're going to 0 with an unsigned int.
        for (uint i = FEE_PERIOD_LENGTH - 1; i < FEE_PERIOD_LENGTH; i--) {
            uint feesAlreadyClaimed = _recentFeePeriodsStorage(i).feesClaimed;
            uint delta = _recentFeePeriodsStorage(i).feesToDistribute.sub(feesAlreadyClaimed);

            if (delta > 0) {
                // Take the smaller of the amount left to claim in the period and the amount we need to allocate
                uint amountInPeriod = delta < remainingToAllocate ? delta : remainingToAllocate;

                _recentFeePeriodsStorage(i).feesClaimed = feesAlreadyClaimed.add(amountInPeriod);
                remainingToAllocate = remainingToAllocate.sub(amountInPeriod);
                feesPaid = feesPaid.add(amountInPeriod);

                // No need to continue iterating if we've recorded the whole amount;
                if (remainingToAllocate == 0) return feesPaid;

                // We've exhausted feePeriods to distribute and no fees remain in last period
                // User last to claim would in this scenario have their remainder slashed
                if (i == 0 && remainingToAllocate > 0) {
                    remainingToAllocate = 0;
                }
            }
        }

        return feesPaid;
    }

    /**
     * @notice Record the reward payment in our recentFeePeriods.
     * @param oksAmount The amount of OKS tokens.
     */
    function _recordRewardPayment(uint oksAmount) internal returns (uint) {
        // Don't assign to the parameter
        uint remainingToAllocate = oksAmount;

        uint rewardPaid;

        // Start at the oldest period and record the amount, moving to newer periods
        // until we've exhausted the amount.
        // The condition checks for overflow because we're going to 0 with an unsigned int.
        for (uint i = FEE_PERIOD_LENGTH - 1; i < FEE_PERIOD_LENGTH; i--) {
            uint toDistribute = _recentFeePeriodsStorage(i).rewardsToDistribute.sub(
                _recentFeePeriodsStorage(i).rewardsClaimed
            );

            if (toDistribute > 0) {
                // Take the smaller of the amount left to claim in the period and the amount we need to allocate
                uint amountInPeriod = toDistribute < remainingToAllocate ? toDistribute : remainingToAllocate;

                _recentFeePeriodsStorage(i).rewardsClaimed = _recentFeePeriodsStorage(i).rewardsClaimed.add(amountInPeriod);
                remainingToAllocate = remainingToAllocate.sub(amountInPeriod);
                rewardPaid = rewardPaid.add(amountInPeriod);

                // No need to continue iterating if we've recorded the whole amount;
                if (remainingToAllocate == 0) return rewardPaid;

                // We've exhausted feePeriods to distribute and no rewards remain in last period
                // User last to claim would in this scenario have their remainder slashed
                // due to rounding up of PreciseDecimal
                if (i == 0 && remainingToAllocate > 0) {
                    remainingToAllocate = 0;
                }
            }
        }
        return rewardPaid;
    }

    /**
     * @notice Send the fees to claiming address.
     * @param account The address to send the fees to.
     * @param oUSDAmount The amount of fees priced in oUSD.
     */
    function _payFees(address account, uint oUSDAmount) internal notFeeAddress(account) {
        // Grab the oUSD Synth
        ISynth oUSDSynth = issuer().synths(oUSD);

        // NOTE: we do not control the FEE_ADDRESS so it is not possible to do an
        // ERC20.approve() transaction to allow this feePool to call ERC20.transferFrom
        // to the accounts address

        // Burn the source amount
        oUSDSynth.burn(FEE_ADDRESS, oUSDAmount);

        // Mint their new synths
        oUSDSynth.issue(account, oUSDAmount);
    }

    /**
     * @notice Send the rewards to claiming address - will be locked in rewardEscrow.
     * @param account The address to send the fees to.
     * @param oksAmount The amount of OKS.
     */
    function _payRewards(address account, uint oksAmount) internal notFeeAddress(account) {
        // Record vesting entry for claiming address and amount
        // OKS already minted to rewardEscrow balance
        rewardEscrow().appendVestingEntry(account, oksAmount);
    }

    /**
     * @notice The total fees available in the system to be withdrawnn in oUSD
     */
    function totalFeesAvailable() external view returns (uint) {
        uint totalFees = 0;

        // Fees in fee period [0] are not yet available for withdrawal
        for (uint i = 1; i < FEE_PERIOD_LENGTH; i++) {
            totalFees = totalFees.add(_recentFeePeriodsStorage(i).feesToDistribute);
            totalFees = totalFees.sub(_recentFeePeriodsStorage(i).feesClaimed);
        }

        return totalFees;
    }

    /**
     * @notice The total OKS rewards available in the system to be withdrawn
     */
    function totalRewardsAvailable() external view returns (uint) {
        uint totalRewards = 0;

        // Rewards in fee period [0] are not yet available for withdrawal
        for (uint i = 1; i < FEE_PERIOD_LENGTH; i++) {
            totalRewards = totalRewards.add(_recentFeePeriodsStorage(i).rewardsToDistribute);
            totalRewards = totalRewards.sub(_recentFeePeriodsStorage(i).rewardsClaimed);
        }

        return totalRewards;
    }

    /**
     * @notice The fees available to be withdrawn by a specific account, priced in oUSD
     * @dev Returns two amounts, one for fees and one for OKS rewards
     */
    function feesAvailable(address account) public view returns (uint, uint) {
        // Add up the fees
        uint[2][FEE_PERIOD_LENGTH] memory userFees = feesByPeriod(account);

        uint totalFees = 0;
        uint totalRewards = 0;

        // Fees & Rewards in fee period [0] are not yet available for withdrawal
        for (uint i = 1; i < FEE_PERIOD_LENGTH; i++) {
            totalFees = totalFees.add(userFees[i][0]);
            totalRewards = totalRewards.add(userFees[i][1]);
        }

        // And convert totalFees to oUSD
        // Return totalRewards as is in OKS amount
        return (totalFees, totalRewards);
    }

    function _isFeesClaimableAndAnyRatesStale(address account) internal view returns (bool, bool) {
        // Threshold is calculated from ratio % above the target ratio (issuanceRatio).
        //  0  <  10%:   Claimable
        // 10% > above:  Unable to claim
        (uint ratio, bool anyRateIsStale) = issuer().collateralisationRatioAndAnyRatesStale(account);
        uint targetRatio = oikosState().issuanceRatio();

        // Claimable if collateral ratio below target ratio
        if (ratio < targetRatio) {
            return (true, anyRateIsStale);
        }

        // Calculate the threshold for collateral ratio before fees can't be claimed.
        uint ratio_threshold = targetRatio.multiplyDecimal(SafeDecimalMath.unit().add(targetThreshold));

        // Not claimable if collateral ratio above threshold
        if (ratio > ratio_threshold) {
            return (false, anyRateIsStale);
        }

        return (true, anyRateIsStale);
    }

    function isFeesClaimable(address account) external view returns (bool feesClaimable) {
        (feesClaimable, ) = _isFeesClaimableAndAnyRatesStale(account);
    }

    /**
     * @notice Calculates fees by period for an account, priced in oUSD
     * @param account The address you want to query the fees for
     */
    function feesByPeriod(address account) public view returns (uint[2][FEE_PERIOD_LENGTH] memory results) {
        // What's the user's debt entry index and the debt they owe to the system at current feePeriod
        uint userOwnershipPercentage;
        uint debtEntryIndex;
        FeePoolState _feePoolState = feePoolState();

        (userOwnershipPercentage, debtEntryIndex) = _feePoolState.getAccountsDebtEntry(account, 0);

        // If they don't have any debt ownership and they never minted, they don't have any fees.
        // User ownership can reduce to 0 if user burns all synths,
        // however they could have fees applicable for periods they had minted in before so we check debtEntryIndex.
        if (debtEntryIndex == 0 && userOwnershipPercentage == 0) {
            uint[2][FEE_PERIOD_LENGTH] memory nullResults;
            return nullResults;
        }

        // The [0] fee period is not yet ready to claim, but it is a fee period that they can have
        // fees owing for, so we need to report on it anyway.
        uint feesFromPeriod;
        uint rewardsFromPeriod;
        (feesFromPeriod, rewardsFromPeriod) = _feesAndRewardsFromPeriod(0, userOwnershipPercentage, debtEntryIndex);

        results[0][0] = feesFromPeriod;
        results[0][1] = rewardsFromPeriod;

        // Retrieve user's last fee claim by periodId
        uint lastFeeWithdrawal = getLastFeeWithdrawal(account);

        // Go through our fee periods from the oldest feePeriod[FEE_PERIOD_LENGTH - 1] and figure out what we owe them.
        // Condition checks for periods > 0
        for (uint i = FEE_PERIOD_LENGTH - 1; i > 0; i--) {
            uint next = i - 1;
            uint nextPeriodStartingDebtIndex = _recentFeePeriodsStorage(next).startingDebtIndex;

            // We can skip the period, as no debt minted during period (next period's startingDebtIndex is still 0)
            if (nextPeriodStartingDebtIndex > 0 && lastFeeWithdrawal < _recentFeePeriodsStorage(i).feePeriodId) {
                // We calculate a feePeriod's closingDebtIndex by looking at the next feePeriod's startingDebtIndex
                // we can use the most recent issuanceData[0] for the current feePeriod
                // else find the applicableIssuanceData for the feePeriod based on the StartingDebtIndex of the period
                uint closingDebtIndex = uint256(nextPeriodStartingDebtIndex).sub(1);

                // Gas optimisation - to reuse debtEntryIndex if found new applicable one
                // if applicable is 0,0 (none found) we keep most recent one from issuanceData[0]
                // return if userOwnershipPercentage = 0)
                (userOwnershipPercentage, debtEntryIndex) = _feePoolState.applicableIssuanceData(account, closingDebtIndex);

                (feesFromPeriod, rewardsFromPeriod) = _feesAndRewardsFromPeriod(i, userOwnershipPercentage, debtEntryIndex);

                results[i][0] = feesFromPeriod;
                results[i][1] = rewardsFromPeriod;
            }
        }
    }

    /**
     * @notice ownershipPercentage is a high precision decimals uint based on
     * wallet's debtPercentage. Gives a precise amount of the feesToDistribute
     * for fees in the period. Precision factor is removed before results are
     * returned.
     * @dev The reported fees owing for the current period [0] are just a
     * running balance until the fee period closes
     */
    function _feesAndRewardsFromPeriod(
        uint period,
        uint ownershipPercentage,
        uint debtEntryIndex
    ) internal view returns (uint, uint) {
        // If it's zero, they haven't issued, and they have no fees OR rewards.
        if (ownershipPercentage == 0) return (0, 0);

        uint debtOwnershipForPeriod = ownershipPercentage;

        // If period has closed we want to calculate debtPercentage for the period
        if (period > 0) {
            uint closingDebtIndex = uint256(_recentFeePeriodsStorage(period - 1).startingDebtIndex).sub(1);
            debtOwnershipForPeriod = _effectiveDebtRatioForPeriod(closingDebtIndex, ownershipPercentage, debtEntryIndex);
        }

        // Calculate their percentage of the fees / rewards in this period
        // This is a high precision integer.
        uint feesFromPeriod = _recentFeePeriodsStorage(period).feesToDistribute.multiplyDecimal(debtOwnershipForPeriod);

        uint rewardsFromPeriod = _recentFeePeriodsStorage(period).rewardsToDistribute.multiplyDecimal(
            debtOwnershipForPeriod
        );

        return (feesFromPeriod.preciseDecimalToDecimal(), rewardsFromPeriod.preciseDecimalToDecimal());
    }

    function _effectiveDebtRatioForPeriod(
        uint closingDebtIndex,
        uint ownershipPercentage,
        uint debtEntryIndex
    ) internal view returns (uint) {
        // Figure out their global debt percentage delta at end of fee Period.
        // This is a high precision integer.
        IOikosState _oikosState = oikosState();
        uint feePeriodDebtOwnership = _oikosState
            .debtLedger(closingDebtIndex)
            .divideDecimalRoundPrecise(_oikosState.debtLedger(debtEntryIndex))
            .multiplyDecimalRoundPrecise(ownershipPercentage);

        return feePeriodDebtOwnership;
    }

    function effectiveDebtRatioForPeriod(address account, uint period) external view returns (uint) {
        require(period != 0, "Current period is not closed yet");
        require(period < FEE_PERIOD_LENGTH, "Exceeds the FEE_PERIOD_LENGTH");

        // If the period being checked is uninitialised then return 0. This is only at the start of the system.
        if (_recentFeePeriodsStorage(period - 1).startingDebtIndex == 0) return 0;

        uint closingDebtIndex = uint256(_recentFeePeriodsStorage(period - 1).startingDebtIndex).sub(1);

        uint ownershipPercentage;
        uint debtEntryIndex;
        (ownershipPercentage, debtEntryIndex) = feePoolState().applicableIssuanceData(account, closingDebtIndex);

        // internal function will check closingDebtIndex has corresponding debtLedger entry
        return _effectiveDebtRatioForPeriod(closingDebtIndex, ownershipPercentage, debtEntryIndex);
    }

    /**
     * @notice Get the feePeriodID of the last claim this account made
     * @param _claimingAddress account to check the last fee period ID claim for
     * @return uint of the feePeriodID this account last claimed
     */
    function getLastFeeWithdrawal(address _claimingAddress) public view returns (uint) {
        return feePoolEternalStorage().getUIntValue(keccak256(abi.encodePacked(LAST_FEE_WITHDRAWAL, _claimingAddress)));
    }

    /**
     * @notice Calculate the collateral ratio before user is blocked from claiming.
     */
    function getPenaltyThresholdRatio() public view returns (uint) {
        uint targetRatio = oikosState().issuanceRatio();

        return targetRatio.multiplyDecimal(SafeDecimalMath.unit().add(targetThreshold));
    }

    /**
     * @notice Set the feePeriodID of the last claim this account made
     * @param _claimingAddress account to set the last feePeriodID claim for
     * @param _feePeriodID the feePeriodID this account claimed fees for
     */
    function _setLastFeeWithdrawal(address _claimingAddress, uint _feePeriodID) internal {
        feePoolEternalStorage().setUIntValue(
            keccak256(abi.encodePacked(LAST_FEE_WITHDRAWAL, _claimingAddress)),
            _feePeriodID
        );
    }

    /* ========== Modifiers ========== */
    modifier onlyExchangerOrSynth {
        bool isExchanger = msg.sender == address(exchanger());
        bool isSynth = issuer().synthsByAddress(msg.sender) != bytes32(0);

        require(isExchanger || isSynth, "Only Exchanger, Synths Authorised");
        _;
    }

    modifier onlyIssuer {
        require(msg.sender == address(issuer()), "FeePool: Only Issuer Authorised");
        _;
    }

    modifier notFeeAddress(address account) {
        require(account != FEE_ADDRESS, "Fee address not allowed");
        _;
    }

    modifier issuanceActive() {
        systemStatus().requireIssuanceActive();
        _;
    }

    /* ========== Proxy Events ========== */

    event IssuanceDebtRatioEntry(
        address indexed account,
        uint debtRatio,
        uint debtEntryIndex,
        uint feePeriodStartingDebtIndex
    );
    bytes32 private constant ISSUANCEDEBTRATIOENTRY_SIG = keccak256(
        "IssuanceDebtRatioEntry(address,uint256,uint256,uint256)"
    );

    function emitIssuanceDebtRatioEntry(
        address account,
        uint debtRatio,
        uint debtEntryIndex,
        uint feePeriodStartingDebtIndex
    ) internal {
        proxy._emit(
            abi.encode(debtRatio, debtEntryIndex, feePeriodStartingDebtIndex),
            2,
            ISSUANCEDEBTRATIOENTRY_SIG,
            bytes32(uint256(uint160(account))),
            0,
            0
        );
    }

    event SynthExchangeFeeUpdated(bytes32 synthKey, uint newExchangeFeeRate);
    bytes32 private constant SYNTHEXCHANGEFEEUPDATED_SIG = keccak256("SynthExchangeFeeUpdated(bytes32,uint256)");

    function emitExchangeFeeUpdated(bytes32 synthKey, uint newExchangeFeeRate) internal {
        proxy._emit(abi.encode(synthKey, newExchangeFeeRate), 1, SYNTHEXCHANGEFEEUPDATED_SIG, 0, 0, 0);
    }

    event FeePeriodDurationUpdated(uint newFeePeriodDuration);
    bytes32 private constant FEEPERIODDURATIONUPDATED_SIG = keccak256("FeePeriodDurationUpdated(uint256)");

    function emitFeePeriodDurationUpdated(uint newFeePeriodDuration) internal {
        proxy._emit(abi.encode(newFeePeriodDuration), 1, FEEPERIODDURATIONUPDATED_SIG, 0, 0, 0);
    }

    event FeePeriodClosed(uint feePeriodId);
    bytes32 private constant FEEPERIODCLOSED_SIG = keccak256("FeePeriodClosed(uint256)");

    function emitFeePeriodClosed(uint feePeriodId) internal {
        proxy._emit(abi.encode(feePeriodId), 1, FEEPERIODCLOSED_SIG, 0, 0, 0);
    }

    event FeesClaimed(address account, uint oUSDAmount, uint oksRewards);
    bytes32 private constant FEESCLAIMED_SIG = keccak256("FeesClaimed(address,uint256,uint256)");

    function emitFeesClaimed(
        address account,
        uint oUSDAmount,
        uint oksRewards
    ) internal {
        proxy._emit(abi.encode(account, oUSDAmount, oksRewards), 1, FEESCLAIMED_SIG, 0, 0, 0);
    }
}
