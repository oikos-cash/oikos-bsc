pragma solidity ^0.5.16;

// Inheritance
import "./interfaces/IERC20.sol";
import "./ExternStateToken.sol";
import "./MixinResolver.sol";
import "./interfaces/IOikos.sol";

// Internal references
import "./interfaces/ISynth.sol";
import "./TokenState.sol";
import "./interfaces/IOikosState.sol";
import "./interfaces/ISystemStatus.sol";
import "./interfaces/IExchanger.sol";
import "./interfaces/IIssuer.sol";
import "./SupplySchedule.sol";
import "./interfaces/IRewardsDistribution.sol";


// https://docs.oikos.cash/contracts/Oikos
contract Oikos is IERC20, ExternStateToken, MixinResolver, IOikos {
    // ========== STATE VARIABLES ==========

    // Available Synths which can be used with the system
    string public constant TOKEN_NAME = "Oikos Network Token";
    string public constant TOKEN_SYMBOL = "OKS";
    uint8 public constant DECIMALS = 18;
    bytes32 public constant oUSD = "oUSD";

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_OIKOSSTATE = "OikosState";
    bytes32 private constant CONTRACT_SYSTEMSTATUS = "SystemStatus";
    bytes32 private constant CONTRACT_EXCHANGER = "Exchanger";
    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_SUPPLYSCHEDULE = "SupplySchedule";
    bytes32 private constant CONTRACT_REWARDSDISTRIBUTION = "RewardsDistribution";

    bytes32[24] private addressesToCache = [
        CONTRACT_SYSTEMSTATUS,
        CONTRACT_EXCHANGER,
        CONTRACT_ISSUER,
        CONTRACT_SUPPLYSCHEDULE,
        CONTRACT_REWARDSDISTRIBUTION,
        CONTRACT_OIKOSSTATE
    ];

    // ========== CONSTRUCTOR ==========

    constructor(
        address payable _proxy,
        TokenState _tokenState,
        address _owner,
        uint _totalSupply,
        address _resolver
    )
        public
        ExternStateToken(_proxy, _tokenState, TOKEN_NAME, TOKEN_SYMBOL, _totalSupply, DECIMALS, _owner)
        MixinResolver(_resolver, addressesToCache)
    {}

    /* ========== VIEWS ========== */

    function oikosState() internal view returns (IOikosState) {
        return IOikosState(resolver.requireAndGetAddress("OikosState", "Missing OikosState address"));
    }

    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(resolver.requireAndGetAddress("SystemStatus", "Missing SystemStatus address"));
    }

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(resolver.requireAndGetAddress("Exchanger", "Missing Exchanger address"));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(resolver.requireAndGetAddress("Issuer", "Missing Issuer address"));
    }

    function supplySchedule() internal view returns (SupplySchedule) {
        return SupplySchedule(resolver.requireAndGetAddress("SupplySchedule", "Missing SupplySchedule address"));
    }

    function rewardsDistribution() internal view returns (IRewardsDistribution) {
        return
            IRewardsDistribution(resolver.requireAndGetAddress("RewardsDistribution", "Missing RewardsDistribution address"));
    }

    function debtBalanceOf(address account, bytes32 currencyKey) external view returns (uint) {
        return issuer().debtBalanceOf(account, currencyKey);
    }

    function totalIssuedSynths(bytes32 currencyKey) external view returns (uint) {
        return issuer().totalIssuedSynths(currencyKey, false);
    }

    function totalIssuedSynthsExcludeEtherCollateral(bytes32 currencyKey) external view returns (uint) {
        return issuer().totalIssuedSynths(currencyKey, true);
    }

    function availableCurrencyKeys() external view returns (bytes32[] memory) {
        return issuer().availableCurrencyKeys();
    }

    function availableSynthCount() external view returns (uint) {
        return issuer().availableSynthCount();
    }

    function availableSynths(uint index) external view returns (ISynth) {
        return issuer().availableSynths(index);
    }

    function synths(bytes32 currencyKey) external view returns (ISynth) {
        return issuer().synths(currencyKey);
    }

    function synthsByAddress(address synthAddress) external view returns (bytes32) {
        return issuer().synthsByAddress(synthAddress);
    }

    function isWaitingPeriod(bytes32 currencyKey) external view returns (bool) {
        return exchanger().maxSecsLeftInWaitingPeriod(messageSender, currencyKey) > 0;
    }

    function anySynthOrOKSRateIsStale() external view returns (bool anyRateStale) {
        return issuer().anySynthOrOKSRateIsStale();
    }

    function maxIssuableSynths(address account) external view returns (uint maxIssuable) {
        return issuer().maxIssuableSynths(account);
    }

    function remainingIssuableSynths(address account)
        external
        view
        returns (
            uint maxIssuable,
            uint alreadyIssued,
            uint totalSystemDebt
        )
    {
        return issuer().remainingIssuableSynths(account);
    }

    function _canTransfer(address account, uint value) internal view returns (bool) {
        (uint initialDebtOwnership, ) = oikosState().issuanceData(account);

        if (initialDebtOwnership > 0) {
            (uint transferable, bool anyRateIsStale) = issuer().transferableOikosAndAnyRateIsStale(
                account,
                tokenState.balanceOf(account)
            );
            require(value <= transferable, "Cannot transfer staked or escrowed OKS");
            require(!anyRateIsStale, "A synth or OKS rate is stale");
        }
        return true;
    }

    // ========== MUTATIVE FUNCTIONS ==========

    function transfer(address to, uint value) external optionalProxy systemActive returns (bool) {
        // Ensure they're not trying to exceed their locked amount -- only if they have debt.
        _canTransfer(messageSender, value);

        // Perform the transfer: if there is a problem an exception will be thrown in this call.
        _transferByProxy(messageSender, to, value);

        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint value
    ) external optionalProxy systemActive returns (bool) {
        // Ensure they're not trying to exceed their locked amount -- only if they have debt.
        _canTransfer(from, value);

        // Perform the transfer: if there is a problem,
        // an exception will be thrown in this call.
        return _transferFromByProxy(messageSender, from, to, value);
    }

    function issueSynths(uint amount) external issuanceActive optionalProxy {
        return issuer().issueSynths(messageSender, amount);
    }

    function issueSynthsOnBehalf(address issueForAddress, uint amount) external issuanceActive optionalProxy {
        return issuer().issueSynthsOnBehalf(issueForAddress, messageSender, amount);
    }

    function issueMaxSynths() external issuanceActive optionalProxy {
        return issuer().issueMaxSynths(messageSender);
    }

    function issueMaxSynthsOnBehalf(address issueForAddress) external issuanceActive optionalProxy {
        return issuer().issueMaxSynthsOnBehalf(issueForAddress, messageSender);
    }

    function burnSynths(uint amount) external issuanceActive optionalProxy {
        return issuer().burnSynths(messageSender, amount);
    }

    function burnSynthsOnBehalf(address burnForAddress, uint amount) external issuanceActive optionalProxy {
        return issuer().burnSynthsOnBehalf(burnForAddress, messageSender, amount);
    }

    function burnSynthsToTarget() external issuanceActive optionalProxy {
        return issuer().burnSynthsToTarget(messageSender);
    }

    function burnSynthsToTargetOnBehalf(address burnForAddress) external issuanceActive optionalProxy {
        return issuer().burnSynthsToTargetOnBehalf(burnForAddress, messageSender);
    }

    function exchange(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey
    ) external /*exchangeActive(sourceCurrencyKey, destinationCurrencyKey)*/ optionalProxy returns (uint amountReceived) {
        return exchanger().exchange(messageSender, sourceCurrencyKey, sourceAmount, destinationCurrencyKey, messageSender);
    }

    function exchangeOnBehalf(
        address exchangeForAddress,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey
    ) external /*exchangeActive(sourceCurrencyKey, destinationCurrencyKey)*/ optionalProxy returns (uint amountReceived) {
        return
            exchanger().exchangeOnBehalf(
                exchangeForAddress,
                messageSender,
                sourceCurrencyKey,
                sourceAmount,
                destinationCurrencyKey
            );
    }

    function settle(bytes32 currencyKey)
        external
        optionalProxy
        returns (
            uint reclaimed,
            uint refunded,
            uint numEntriesSettled
        )
    {
        return exchanger().settle(messageSender, currencyKey);
    }

    function collateralisationRatio(address _issuer) external view returns (uint) {
        return issuer().collateralisationRatio(_issuer);
    }

    function collateral(address account) external view returns (uint) {
        return issuer().collateral(account);
    }

    function transferableOikos(address account) external view returns (uint transferable) {
        (transferable, ) = issuer().transferableOikosAndAnyRateIsStale(account, tokenState.balanceOf(account));
    }

    function mint() external issuanceActive returns (bool) {
        require(address(rewardsDistribution()) != address(0), "RewardsDistribution not set");

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
        tokenState.setBalanceOf(
            address(_rewardsDistribution),
            tokenState.balanceOf(address(_rewardsDistribution)).add(amountToDistribute)
        );
        emitTransfer(address(this), address(_rewardsDistribution), amountToDistribute);

        // Kick off the distribution of rewards
        _rewardsDistribution.distributeRewards(amountToDistribute);

        // Assign the minters reward.
        tokenState.setBalanceOf(msg.sender, tokenState.balanceOf(msg.sender).add(minterReward));
        emitTransfer(address(this), msg.sender, minterReward);

        totalSupply = totalSupply.add(supplyToMint);

        return true;
    }

    function liquidateDelinquentAccount(address account, uint susdAmount)
        external
        systemActive
        optionalProxy
        returns (bool)
    {
        (uint totalRedeemed, uint amountLiquidated) = issuer().liquidateDelinquentAccount(
            account,
            susdAmount,
            messageSender
        );

        emitAccountLiquidated(account, totalRedeemed, amountLiquidated, messageSender);

        // Transfer OKS redeemed to messageSender
        // Reverts if amount to redeem is more than balanceOf account, ie due to escrowed balance
        return _transferByProxy(account, messageSender, totalRedeemed);
    }

    // ========== MODIFIERS ==========

    modifier onlyExchanger() {
        require(msg.sender == address(exchanger()), "Only Exchanger can invoke this");
        _;
    }

    modifier systemActive() {
        systemStatus().requireSystemActive();
        _;
    }

    modifier issuanceActive() {
        systemStatus().requireIssuanceActive();
        _;
    }

    modifier exchangeActive(bytes32 src, bytes32 dest) {
        systemStatus().requireExchangeActive();
        systemStatus().requireSynthsActive(src, dest);
        _;
    }

    // ========== EVENTS ==========

    event SynthExchange(
        address indexed account,
        bytes32 fromCurrencyKey,
        uint256 fromAmount,
        bytes32 toCurrencyKey,
        uint256 toAmount,
        address toAddress
    );
    bytes32 internal constant SYNTHEXCHANGE_SIG = keccak256(
        "SynthExchange(address,bytes32,uint256,bytes32,uint256,address)"
    );

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
            addressToBytes32(account),
            0,
            0
        );
    }

    event ExchangeReclaim(address indexed account, bytes32 currencyKey, uint amount);
    bytes32 internal constant EXCHANGERECLAIM_SIG = keccak256("ExchangeReclaim(address,bytes32,uint256)");

    function emitExchangeReclaim(
        address account,
        bytes32 currencyKey,
        uint256 amount
    ) external onlyExchanger {
        proxy._emit(abi.encode(currencyKey, amount), 2, EXCHANGERECLAIM_SIG, addressToBytes32(account), 0, 0);
    }

    event ExchangeRebate(address indexed account, bytes32 currencyKey, uint amount);
    bytes32 internal constant EXCHANGEREBATE_SIG = keccak256("ExchangeRebate(address,bytes32,uint256)");

    function emitExchangeRebate(
        address account,
        bytes32 currencyKey,
        uint256 amount
    ) external onlyExchanger {
        proxy._emit(abi.encode(currencyKey, amount), 2, EXCHANGEREBATE_SIG, addressToBytes32(account), 0, 0);
    }

    event AccountLiquidated(address indexed account, uint oksRedeemed, uint amountLiquidated, address liquidator);
    bytes32 internal constant ACCOUNTLIQUIDATED_SIG = keccak256("AccountLiquidated(address,uint256,uint256,address)");

    function emitAccountLiquidated(
        address account,
        uint256 oksRedeemed,
        uint256 amountLiquidated,
        address liquidator
    ) internal {
        proxy._emit(
            abi.encode(oksRedeemed, amountLiquidated, liquidator),
            2,
            ACCOUNTLIQUIDATED_SIG,
            addressToBytes32(account),
            0,
            0
        );
    }
}
