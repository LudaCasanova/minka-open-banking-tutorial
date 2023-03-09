import { beginActionNew, endAction, saveIntent } from './common.js'
import { ledgerSigner, notifyLedger } from '../ledger.js'
import {
  extractAndValidateData,
  validateAction,
  validateEntity,
} from '../validators.js'
import { updateEntry } from '../persistence.js'
import core from '../core.js'

export async function prepareDebit(req, res) {
  const action = 'prepare'

  let { alreadyRunning, entry } = await beginActionNew({
    request: req,
    action,
  })

  res.sendStatus(202)

  if (!alreadyRunning) {
    await processPrepareDebit(entry)
    await endAction(entry)
  }

  await notifyLedger(entry, action, ['prepared', 'failed'])
}

async function processPrepareDebit(entry) {
  const action = entry.actions[entry.processingAction]
  let transaction
  try {
    validateEntity(
      { hash: entry.hash, data: entry.data, meta: entry.meta },
      ledgerSigner,
    )
    validateEntity(entry.data?.intent)
    validateAction(action.action, entry.processingAction)

    const { address, symbol, amount } = extractAndValidateData({
      entry,
      schema: 'debit',
    })
    entry.schema = 'debit'
    entry.account = address.account
    entry.symbol = symbol
    entry.amount = amount

    await updateEntry(entry)
    await saveIntent(entry.data.intent)

    // Process the entry
    // Prepare for debit needs to check if the account exists, is active and hold the funds.
    // Since the core will throw an Error if the amount can not be put on hold for any reason, we
    // can try to hold the amount and catch the Error.
    transaction = core.hold(
      Number(entry.account),
      entry.amount,
      `${entry.handle}-hold`,
    )
    action.coreId = transaction.id.toString()

    if (transaction.status !== 'COMPLETED') {
      throw new Error(transaction.errorReason)
    }

    action.state = 'prepared'
  } catch (error) {
    console.log(error)
    action.state = 'failed'
    action.error = {
      reason: 'bridge.unexpected-error',
      detail: error.message,
      failId: undefined,
    }
  }
}