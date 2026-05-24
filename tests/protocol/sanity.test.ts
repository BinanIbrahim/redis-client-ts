import { describe, it, expect } from 'vitest';
import { VERSION } from '../../src/index.js';

describe('toolchain sanity', () => {
  it('imports from src and runs vitest', () => {
    expect(VERSION).toBe('0.0.1');
  });
});
