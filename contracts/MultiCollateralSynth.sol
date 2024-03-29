pragma solidity ^0.5.16;

// Inheritance
import "./Synth.sol";

// https://docs.oikos.cash/contracts/MultiCollateralSynth
contract MultiCollateralSynth is Synth {
    bytes32 public multiCollateralKey;
    bytes32 private constant CONTRACT_ETHERCOLLATERALOUSD = "EtherCollateraloUSD";

    /* ========== CONSTRUCTOR ========== */

    constructor(
        address payable _proxy,
        TokenState _tokenState,
        string memory _tokenName,
        string memory _tokenSymbol,
        address _owner,
        bytes32 _currencyKey,
        uint _totalSupply,
        address _resolver,
        bytes32 _multiCollateralKey
    ) public Synth(_proxy, _tokenState, _tokenName, _tokenSymbol, _owner, _currencyKey, _totalSupply, _resolver) {
        multiCollateralKey = _multiCollateralKey;

        appendToAddressCache(multiCollateralKey);
    }

    /* ========== VIEWS ======================= */

    function multiCollateral() internal view returns (address) {
        return requireAndGetAddress(multiCollateralKey, "Resolver is missing multiCollateral address");
    }

    function etherCollateraloUSD() internal view returns (IEtherCollateraloUSD) {
        return IEtherCollateraloUSD(resolver.requireAndGetAddress(CONTRACT_ETHERCOLLATERALOUSD, "Missing EtherCollateraloUSD address"));
    }
    /* ========== MUTATIVE FUNCTIONS ========== */

    /**
     * @notice Function that allows multi Collateral to issue a certain number of synths from an account.
     * @param account Account to issue synths to
     * @param amount Number of synths
     */
    function issue(address account, uint amount) external onlyInternalContracts {
        super._internalIssue(account, amount);
    }

    /**
     * @notice Function that allows multi Collateral to burn a certain number of synths from an account.
     * @param account Account to burn synths from
     * @param amount Number of synths
     */
    function burn(address account, uint amount) external onlyInternalContracts {
        super._internalBurn(account, amount);
    }

    /* ========== MODIFIERS ========== */

    // Contracts directly interacting with multiCollateralSynth to issue and burn
    modifier onlyInternalContracts() {
        bool isOikos = msg.sender == address(oikos());
        bool isFeePool = msg.sender == address(feePool());
        bool isExchanger = msg.sender == address(exchanger());
        bool isIssuer = msg.sender == address(issuer());
        bool isMultiCollateral = msg.sender == address(multiCollateral());
        bool isEtherCollateraloUSD = msg.sender == address(etherCollateraloUSD());

        require(
            isOikos || isFeePool || isExchanger || isIssuer || isMultiCollateral || isEtherCollateraloUSD,
            "Only Oikos, FeePool, Exchanger, Issuer or MultiCollateral contracts allowed"
        );
        _;
    }
}
