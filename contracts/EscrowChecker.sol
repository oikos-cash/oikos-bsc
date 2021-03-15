pragma solidity 0.4.25;


contract OikosEscrow {
    function numVestingEntries(address account) public returns (uint);

    function getVestingScheduleEntry(address account, uint index) public returns (uint[2]);
}


contract EscrowChecker {
    OikosEscrow public oikos_escrow;

    constructor(OikosEscrow _esc) public {
        oikos_escrow = _esc;
    }

    function checkAccountSchedule(address account) public view returns (uint[16]) {
        uint[16] memory _result;
        uint schedules = oikos_escrow.numVestingEntries(account);
        for (uint i = 0; i < schedules; i++) {
            uint[2] memory pair = oikos_escrow.getVestingScheduleEntry(account, i);
            _result[i * 2] = pair[0];
            _result[i * 2 + 1] = pair[1];
        }
        return _result;
    }
}
