import "DFSEscrowInvestorTransactionHandler"
import "FlowTransactionScheduler"

transaction() {
    prepare(signer: auth(Storage, Capabilities) &Account) {
        if signer.storage.borrow<&AnyResource>(from: /storage/DFSEscrowInvestorTransactionHandler) == nil {
            let handler <- DFSEscrowInvestorTransactionHandler.createHandler()
            signer.storage.save(<-handler, to: /storage/DFSEscrowInvestorTransactionHandler)

            signer.capabilities.storage
                .issue<auth(FlowTransactionScheduler.Execute) &{FlowTransactionScheduler.TransactionHandler}>(/storage/DFSEscrowInvestorTransactionHandler)

            let publicCap = signer.capabilities.storage
                .issue<&{FlowTransactionScheduler.TransactionHandler}>(/storage/DFSEscrowInvestorTransactionHandler)

            signer.capabilities.publish(publicCap, at: /public/DFSEscrowInvestorTransactionHandler)
        }
    }
}
