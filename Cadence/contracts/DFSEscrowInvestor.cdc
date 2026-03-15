import "EVM"

/// DFSEscrowInvestor calls investEscrowFunds on the EVM DFSEscrowManager for all
/// active escrows that are eligible (past endTime, not yet invested, etc.).
/// Deployed to frontend-agent; uses the account's COA at /storage/evm for cross-VM calls.
///
/// DFSEscrowManager mainnet: 0x97a582e24B6a68a4D654421D46c89B9923F1Fd40
access(all) contract DFSEscrowInvestor {

    access(all) let escrowManagerAddress: EVM.EVMAddress

    access(all) fun investActiveEscrows() {
        let coa = self.account.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("Could not borrow COA")

        // 1. Read active escrow IDs from EVM
        let getIdsCallData = EVM.encodeABIWithSignature("getActiveEscrowIds()", [])
        let getIdsResult = coa.call(
            to: self.escrowManagerAddress,
            data: getIdsCallData,
            gasLimit: 1_000_000,
            value: EVM.Balance(attoflow: 0)
        )
        if getIdsResult.status != EVM.Status.successful {
            return
        }

        let decoded = EVM.decodeABI(types: [Type<[UInt256]>()], data: getIdsResult.data) as! [AnyStruct]
        let activeIds = decoded[0] as! [UInt256]

        // 2. Try investEscrowFunds for each -- skip failures
        for escrowId in activeIds {
            let investCallData = EVM.encodeABIWithSignature(
                "investEscrowFunds(uint256)",
                [escrowId]
            )
            let investResult = coa.call(
                to: self.escrowManagerAddress,
                data: investCallData,
                gasLimit: 500_000,
                value: EVM.Balance(attoflow: 0)
            )
            // Intentionally NOT asserting -- failed calls are expected
            // (escrow not past endTime, already invested, no pool, etc.)
        }
    }

    init() {
        self.escrowManagerAddress = EVM.addressFromString("0x97a582e24B6a68a4D654421D46c89B9923F1Fd40")
    }
}
