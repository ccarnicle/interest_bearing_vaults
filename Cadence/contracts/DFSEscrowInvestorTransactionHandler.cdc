import "FlowTransactionScheduler"
import "FlowTransactionSchedulerUtils"
import "DFSEscrowInvestor"
import "FlowToken"
import "FungibleToken"

access(all)
contract DFSEscrowInvestorTransactionHandler {
    /// Handler resource that implements the Scheduled Transaction interface
    access(all) resource Handler: FlowTransactionScheduler.TransactionHandler {
        access(FlowTransactionScheduler.Execute) fun executeTransaction(id: UInt64, data: AnyStruct?) {
            DFSEscrowInvestor.investActiveEscrows()

            var delay: UFix64 = 86400.0 // 1 day in seconds
            let future = getCurrentBlock().timestamp + delay
            let priority = FlowTransactionScheduler.Priority.Medium
            let executionEffort: UInt64 = 5000

            let estimate = FlowTransactionScheduler.estimate(
                data: data,
                timestamp: future,
                priority: priority,
                executionEffort: executionEffort
            )

            assert(
                estimate.timestamp != nil || priority == FlowTransactionScheduler.Priority.Low,
                message: estimate.error ?? "estimation failed"
            )

            // Ensure a handler resource exists in the contract account storage
            if DFSEscrowInvestorTransactionHandler.account.storage.borrow<&AnyResource>(from: /storage/DFSEscrowInvestorTransactionHandler) == nil {
                let handler <- DFSEscrowInvestorTransactionHandler.createHandler()
                DFSEscrowInvestorTransactionHandler.account.storage.save(<-handler, to: /storage/DFSEscrowInvestorTransactionHandler)

                let publicCap = DFSEscrowInvestorTransactionHandler.account.capabilities.storage
                    .issue<&{FlowTransactionScheduler.TransactionHandler}>(/storage/DFSEscrowInvestorTransactionHandler)

                DFSEscrowInvestorTransactionHandler.account.capabilities.publish(publicCap, at: /public/DFSEscrowInvestorTransactionHandler)
            }

            let vaultRef = DFSEscrowInvestorTransactionHandler.account.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(from: /storage/flowTokenVault)
                ?? panic("missing FlowToken vault on contract account")
            let feesVault <- vaultRef.withdraw(amount: estimate.flowFee ?? 0.0) as! @FlowToken.Vault

            let manager = DFSEscrowInvestorTransactionHandler.account.storage.borrow<auth(FlowTransactionSchedulerUtils.Owner) &{FlowTransactionSchedulerUtils.Manager}>(from: FlowTransactionSchedulerUtils.managerStoragePath)
                ?? panic("Could not borrow a Manager reference from \(FlowTransactionSchedulerUtils.managerStoragePath)")

            let handlerTypeIdentifier = Type<@DFSEscrowInvestorTransactionHandler.Handler>().identifier

            manager.scheduleByHandler(
                handlerTypeIdentifier: handlerTypeIdentifier,
                handlerUUID: nil,
                data: data,
                timestamp: future,
                priority: priority,
                executionEffort: executionEffort,
                fees: <-feesVault
            )
        }

        access(all) view fun getViews(): [Type] {
            return [Type<StoragePath>(), Type<PublicPath>()]
        }

        access(all) fun resolveView(_ view: Type): AnyStruct? {
            switch view {
                case Type<StoragePath>():
                    return /storage/DFSEscrowInvestorTransactionHandler
                case Type<PublicPath>():
                    return /public/DFSEscrowInvestorTransactionHandler
                default:
                    return nil
            }
        }
    }

    access(all) fun createHandler(): @Handler {
        return <- create Handler()
    }
}
