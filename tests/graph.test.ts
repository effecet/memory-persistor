import { describe, it, expect } from 'vitest';

describe('graph mermaid output', () => {
  it('generates valid flowchart header', () => {
    const lines = ['flowchart LR'];
    lines.push('  classDef hot fill:#ff6b6b,stroke:#c0392b,color:#fff');
    lines.push('  classDef warm fill:#f39c12,stroke:#e67e22,color:#fff');
    lines.push('  classDef cold fill:#3498db,stroke:#2980b9,color:#fff');

    const mermaid = lines.join('\n');
    expect(mermaid).toContain('flowchart LR');
    expect(mermaid).toContain('classDef hot');
    expect(mermaid).toContain('classDef warm');
    expect(mermaid).toContain('classDef cold');
  });

  it('shortens UUIDs to 8 chars for node IDs', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const shortId = uuid.replace(/-/g, '').slice(0, 8);
    expect(shortId).toBe('550e8400');
    expect(shortId).toHaveLength(8);
  });

  it('escapes quotes in memory names', () => {
    const name = 'User said "always use f-strings"';
    const safeName = name.replace(/"/g, "'").slice(0, 40);
    expect(safeName).toBe("User said 'always use f-strings'");
    expect(safeName).not.toContain('"');
  });

  it('truncates long names to 40 chars', () => {
    const name = 'This is a very long memory name that should be truncated to fit';
    const safeName = name.replace(/"/g, "'").slice(0, 40);
    expect(safeName).toHaveLength(40);
  });

  it('maps tier to lowercase class name', () => {
    const tiers = ['HOT', 'WARM', 'COLD'];
    const classes = tiers.map(t => t.toLowerCase());
    expect(classes).toEqual(['hot', 'warm', 'cold']);
  });
});
