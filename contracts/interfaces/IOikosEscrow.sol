pragma solidity 0.4.25;


/**
 * @title OikosEscrow interface
 */
interface IOikosEscrow {
    function balanceOf(address account) public view returns (uint);

    function appendVestingEntry(address account, uint quantity) public;
}
