import { describe, expect, it, vi } from 'vitest';
import { GameHooks } from '../src/systems/hooks';

describe('GameHooks (the edition surface)', () => {
  it('delivers events to every listener until it unsubscribes', () => {
    const h = new GameHooks();
    const a: number[] = [];
    const b: number[] = [];
    const offA = h.on('tick', ({ dt }) => a.push(dt));
    h.on('tick', ({ dt }) => b.push(dt));
    expect(h.has('tick')).toBe(true);
    expect(h.has('kill')).toBe(false);
    h.emit('tick', { dt: 1 });
    offA();
    h.emit('tick', { dt: 2 });
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  it('keeps the game running when a listener throws', () => {
    const h = new GameHooks();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: string[] = [];
    h.on('remembrance', () => {
      throw new Error('edition bug');
    });
    h.on('remembrance', ({ choice }) => got.push(choice));
    expect(() => h.emit('remembrance', { choice: 'purify' })).not.toThrow();
    expect(got).toEqual(['purify']);
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });

  it('lets a listener unsubscribe itself mid-emit without skipping the next one', () => {
    const h = new GameHooks();
    const got: number[] = [];
    const off = h.on('echo', () => {
      got.push(1);
      off();
    });
    h.on('echo', () => got.push(2));
    h.emit('echo', { x: 0, z: 0, source: 'manual' });
    h.emit('echo', { x: 0, z: 0, source: 'manual' });
    expect(got).toEqual([1, 2, 2]);
  });

  it('has no travel gate by default', () => {
    expect(new GameHooks().travelGate).toBeNull();
  });
});
