pragma solidity 0.4.25;


/**
 * @title Oikos Depot interface
 */
contract IDepot {
    function exchangeEtherForSynths() public payable returns (uint);

    function exchangeEtherForSynthsAtRate(uint guaranteedRate) external payable returns (uint);

    function depositSynths(uint amount) external;

    function withdrawMyDepositedSynths() external;

    // Deprecated ABI for MAINNET. Only used on Testnets
    function exchangeEtherForOKS() external payable returns (uint);

    function exchangeEtherForOKSAtRate(uint guaranteedRate) external payable returns (uint);

    function exchangeSynthsForOKS() external payable returns (uint);
}
