const { ethers, getDefaultProvider } = require('ethers');
const BN = require('bignumber.js');

const provider = getDefaultProvider(process.env.QUICKNODE_KEY);
const privateKey = process.env.ADMIN_PRIVATE_KEY;
const wallet = new ethers.Wallet(privateKey, provider);
const ExchangeState = require('../../../build/contracts/ExchangeState.json');
const Exchanger = require('../../../build/contracts/Exchanger.json');


const exchanger = Exchanger.address;
const owner = wallet.address;

console.log(Exchanger.address)

const _ExchangeState = new ethers.Contract(ExchangeState.address, ExchangeState.abi, wallet);
const overrideOptions = {
    gasLimit: 15000000,
    gasPrice: 5000000000,
    from: owner
};

let doNotRemove = false;
let tx;

const bytes32 = (key) => ethers.utils.formatBytes32String(key);

const restore = async() => {
    let associatedContract = await _ExchangeState.associatedContract();
    const flag = (associatedContract != exchanger);
    const extraMsg = flag ? "Restoring ..." : "";
    
    console.log(`Associated contract is ${associatedContract} ${extraMsg}`);

    if (flag) {
        tx = await _ExchangeState.setAssociatedContract(exchanger, overrideOptions);
        console.log(tx);
    }
}

const run = async (address) => {

    const overrideOptions = {
        gasLimit: 15000000,
        gasPrice: 5000000000,
        from: owner
    };

    let associatedContract = await _ExchangeState.associatedContract();
    const flag = (associatedContract != exchanger);
    const extraMsg = flag ? "Restoring ..." : "";
    
    console.log(`Associated contract is ${associatedContract} ${extraMsg}`);

    if (flag) {
        tx = await _ExchangeState.setAssociatedContract(exchanger, overrideOptions);
        console.log(tx);
    }

    const synthKeys = [ "oUSD",
                        "oBTC",
                        "oETH",
                        "oBNB",
                        "oXAU",
                        "iBTC",
                        "iETH",
                        "iBNB" ];

    //check all synths, change associated contract and remove entries
    synthKeys.forEach(async (key) => {

        try {

            let entry = await _ExchangeState.getEntryAt(address, bytes32(key), 0)    ;

            if (entry.amountReceived > 0) {
                
                
                console.log(`Found entry for ${key}`);

                if (!doNotRemove) {
                    
                    if (associatedContract != owner) {
                        tx = await _ExchangeState.setAssociatedContract(owner, overrideOptions);
                        console.log(tx);
                    }
    
                    tx = await _ExchangeState.removeEntries(address, bytes32(key), overrideOptions);
                    console.log(tx);
                }
            }

        } catch (error) {
                 
            if (String(error).indexOf("0xfe") > -1) {
                //console.log(error)
                console.log(`No entries found for ${key}`);
            }      
        }

    });

}
module.exports = {
    run, 
    restore
};