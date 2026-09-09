import { Router } from 'express'
import { requireAdmin } from './auth.js'
import { config } from './config.js'
import { withTransaction } from './db.js'
import { loadDictionaries } from './dictionaries.js'
import { loadNotificationRuleSettings, notificationRulesUpdateSchema, saveNotificationRuleSettings } from './notificationRules.js'

const router = Router()
router.use(requireAdmin)

function deliveryMode() { return !config.dingtalk.enabled ? 'disabled' : config.dingtalk.dryRun ? 'dry_run' : 'live' }

router.get('/', async (_request, response) => {
  const [settings, { dictionaries, dictionaryVersions }] = await Promise.all([loadNotificationRuleSettings(), loadDictionaries()])
  response.json({ ...settings, statuses: dictionaries.status, statusVersion: dictionaryVersions.status, deliveryMode: deliveryMode() })
})

router.put('/', async (request, response) => {
  const parsed = notificationRulesUpdateSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message ?? '通知规则无效' })
  const result = await withTransaction(async (client) => {
    const settings = await saveNotificationRuleSettings(client, request.auth!.user.id, parsed.data)
    const { dictionaries, dictionaryVersions } = await loadDictionaries(client)
    return { ...settings, statuses: dictionaries.status, statusVersion: dictionaryVersions.status, deliveryMode: deliveryMode() }
  })
  response.json(result)
})

export default router
