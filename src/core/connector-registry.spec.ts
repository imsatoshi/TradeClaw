import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerConnector,
  touchInteraction,
  getLastInteraction,
  resolveDeliveryTarget,
  listConnectors,
  hasConnectors,
  _resetForTest,
} from './connector-registry.js'

beforeEach(() => {
  _resetForTest()
})

describe('connector-registry', () => {
  describe('registerConnector', () => {
    it('should register and list connectors', () => {
      registerConnector({ channel: 'telegram', to: '123', deliver: async () => {} })

      expect(hasConnectors()).toBe(true)
      expect(listConnectors()).toHaveLength(1)
      expect(listConnectors()[0].channel).toBe('telegram')
    })

    it('should replace existing registration for same channel', () => {
      registerConnector({ channel: 'telegram', to: '123', deliver: async () => {} })
      registerConnector({ channel: 'telegram', to: '456', deliver: async () => {} })

      expect(listConnectors()).toHaveLength(1)
      expect(listConnectors()[0].to).toBe('456')
    })

    it('should support multiple channels', () => {
      registerConnector({ channel: 'telegram', to: '123', deliver: async () => {} })
      registerConnector({ channel: 'discord', to: '#general', deliver: async () => {} })

      expect(listConnectors()).toHaveLength(2)
    })

    it('should return an unregister function', () => {
      const unregister = registerConnector({ channel: 'telegram', to: '123', deliver: async () => {} })

      expect(hasConnectors()).toBe(true)
      unregister()
      expect(hasConnectors()).toBe(false)
    })
  })

  describe('touchInteraction', () => {
    it('should record the last interaction', () => {
      touchInteraction('telegram', '123')

      const last = getLastInteraction()
      expect(last).not.toBeNull()
      expect(last!.channel).toBe('telegram')
      expect(last!.to).toBe('123')
      expect(last!.ts).toBeGreaterThan(0)
    })

    it('should update on subsequent interactions', () => {
      touchInteraction('telegram', '123')
      touchInteraction('discord', '#general')

      const last = getLastInteraction()
      expect(last!.channel).toBe('discord')
      expect(last!.to).toBe('#general')
    })
  })

  describe('resolveDeliveryTarget', () => {
    it('should return last-interacted connector', () => {
      const tgDeliver = async () => {}
      const dcDeliver = async () => {}
      registerConnector({ channel: 'telegram', to: '123', deliver: tgDeliver })
      registerConnector({ channel: 'discord', to: '#general', deliver: dcDeliver })

      touchInteraction('discord', '#general')

      const target = resolveDeliveryTarget()
      expect(target).not.toBeNull()
      expect(target!.channel).toBe('discord')
      expect(target!.deliver).toBe(dcDeliver)
    })

    it('should fall back to first connector when no interaction yet', () => {
      registerConnector({ channel: 'telegram', to: '123', deliver: async () => {} })

      const target = resolveDeliveryTarget()
      expect(target).not.toBeNull()
      expect(target!.channel).toBe('telegram')
    })

    it('should fall back when last-interacted channel was unregistered', () => {
      const unregister = registerConnector({ channel: 'telegram', to: '123', deliver: async () => {} })
      registerConnector({ channel: 'discord', to: '#general', deliver: async () => {} })

      touchInteraction('telegram', '123')
      unregister()

      const target = resolveDeliveryTarget()
      expect(target).not.toBeNull()
      expect(target!.channel).toBe('discord')
    })

    it('should return null when no connectors registered', () => {
      const target = resolveDeliveryTarget()
      expect(target).toBeNull()
    })

    it('should return null when no connectors and no interaction', () => {
      touchInteraction('telegram', '123')

      const target = resolveDeliveryTarget()
      expect(target).toBeNull()
    })
  })
})
