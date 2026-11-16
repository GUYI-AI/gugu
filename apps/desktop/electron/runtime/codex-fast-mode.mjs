/** Fast comes from the current model's live catalog, never a model-name allowlist. */
export function codexFastTier(model) {
  return model?.serviceTiers?.find((tier) => tier && typeof tier.id === 'string'
    && (tier.id === 'priority' || tier.id === 'fast' || tier.name === 'Fast'))?.id ?? null
}

export function codexFastConfigOptions(model, enabled) {
  if (!codexFastTier(model)) return []
  return [{
    configId: 'fast', name: 'Fast', category: 'model_config', type: 'select',
    currentValue: enabled ? 'on' : 'off',
    options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On' }],
  }]
}

/** A turn-local override also clears a user's global default when Fast is off. */
export function codexTierForTurn(model, enabled) {
  return enabled ? (codexFastTier(model) ?? 'default') : 'default'
}
