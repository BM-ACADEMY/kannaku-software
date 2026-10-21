import React from 'react';
import { inr2 } from '../lib/format.js';
import { useApp } from './ui.jsx';

// rules: [{brand_id, pct}] · amount: rupees, to preview each brand's slice
export const splitBrands = (boot) => boot.brands.filter((b) => b.active && b.code !== 'HO');

export function splitTotal(rules) {
  return Math.round((rules || []).reduce((s, r) => s + (Number(r.pct) || 0), 0) * 1000) / 1000;
}

export default function SplitEditor({ rules, onChange, amount }) {
  const { boot } = useApp();
  const brands = splitBrands(boot);
  const pctOf = (id) => rules.find((r) => r.brand_id === id)?.pct ?? '';
  const set = (id, v) => {
    const rest = rules.filter((r) => r.brand_id !== id);
    onChange(v === '' || Number(v) === 0 ? rest : [...rest, { brand_id: id, pct: Number(v) }]);
  };
  const equal = () => {
    const picked = rules.length >= 2 ? rules.map((r) => r.brand_id) : brands.map((b) => b.id);
    const each = Math.floor((100 / picked.length) * 100) / 100;
    onChange(picked.map((id, i) => ({ brand_id: id, pct: i === 0 ? Math.round((100 - each * (picked.length - 1)) * 100) / 100 : each })));
  };
  const total = splitTotal(rules);
  return (
    <div className="split-box">
      <div className="split-grid">
        {brands.map((b) => {
          const pct = pctOf(b.id);
          return (
            <label key={b.id} className={`split-row${pct ? ' on' : ''}`}>
              <span className="dot" style={{ background: b.color }} />
              <span className="split-name">{b.name}</span>
              <input className="input" type="number" min="0" max="100" step="0.5" value={pct} placeholder="0" onChange={(e) => set(b.id, e.target.value)} />
              <span className="small muted split-pct">%</span>
              {amount ? <span className="num small split-amt">{pct ? inr2((Number(amount) * Number(pct)) / 100) : ''}</span> : null}
            </label>
          );
        })}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="btn sm" onClick={equal}>Split equally{rules.length >= 2 ? ' (selected)' : ''}</button>
        <span className="spacer" />
        <span className={`small ${Math.abs(total - 100) < 0.01 ? 'in' : 'out'}`} style={{ fontWeight: 600 }}>Total {total}% {Math.abs(total - 100) < 0.01 ? '✓' : '— must be 100%'}</span>
      </div>
    </div>
  );
}
