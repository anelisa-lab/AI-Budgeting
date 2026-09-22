/**
 * Landing screen — the public front page.
 * Member 7.
 */

import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Eyebrow } from '../components/ui/index.js';
import { NSFAS } from '../context/BudgetContext.jsx';
import { money } from '../lib/format.js';

const STEPS = [
  {
    n: '01',
    title: 'Tell Mintly what landed',
    body: 'Your allowance and the date it paid. Mintly works out a safe daily spend.',
  },
  {
    n: '02',
    title: 'Search before you shop',
    body: 'Set your ceiling and how far you can travel. Every match is ranked on total cost.',
  },
  {
    n: '03',
    title: 'Shop where it is cheapest',
    body: 'One list, priced at every store, so the same trolley does not cost you more.',
  },
];

export default function Landing() {
  const navigate = useNavigate();
  const weekly = NSFAS.livingAllowanceMonthly / (52 / 12);

  // The catalogue lives on the backend now and GET /search needs a token, so
  // this public page cannot count it. Rather than print a number we cannot
  // stand behind, the badges below describe what the app does.

  return (
    <div className="stack stack--loose">
      <section style={{ paddingBlock: 'var(--s-10)' }}>
        <Eyebrow>Built for DUT residence students</Eyebrow>
        <h1 style={{ fontSize: 'clamp(38px, 7vw, 64px)', color: 'var(--c-forest)', marginTop: 'var(--s-4)', maxWidth: '16ch' }}>
          Make the allowance last the month.
        </h1>
        <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-md)', marginTop: 'var(--s-5)', maxWidth: '54ch' }}>
          NSFAS pays {money(NSFAS.livingAllowanceMonthly)} a month for living costs —
          about {money(weekly)} a week. Mintly turns that into a daily number you can
          actually shop against, then finds the cheapest place to buy what you need.
        </p>
        <div className="row" style={{ marginTop: 'var(--s-8)', gap: 'var(--s-3)' }}>
          <Button size="lg" onClick={() => navigate('/register')}>
            Create my budget →
          </Button>
          <Button size="lg" variant="secondary" onClick={() => navigate('/login')}>
            I already have an account
          </Button>
        </div>
        <div className="row" style={{ marginTop: 'var(--s-6)', gap: 'var(--s-2)' }}>
          <Badge tone="neutral">Live prices from every listed store</Badge>
          <Badge tone="neutral">One list, priced everywhere</Badge>
          <Badge tone="neutral">Free for DUT students</Badge>
        </div>
      </section>

      <section>
        <Eyebrow>How it works</Eyebrow>
        <div
          className="stat-row"
          style={{ marginTop: 'var(--s-5)', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
        >
          {STEPS.map((s) => (
            <Card key={s.n}>
              <span
                aria-hidden="true"
                style={{
                  display: 'grid', placeItems: 'center',
                  width: 38, height: 38, borderRadius: '50%',
                  background: 'var(--c-coral)', color: '#fff',
                  fontWeight: 'var(--fw-black)', fontSize: 'var(--t-xs)',
                }}
              >
                {s.n}
              </span>
              <h3 style={{ fontSize: 'var(--t-lg)', marginTop: 'var(--s-4)' }}>{s.title}</h3>
              <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-2)' }}>
                {s.body}
              </p>
            </Card>
          ))}
        </div>
      </section>

      <Card tone="forest">
        <Eyebrow onDark>Why it matters</Eyebrow>
        <h2 style={{ fontSize: 'var(--t-xl)', color: '#F3EFE2', marginTop: 'var(--s-4)', maxWidth: '24ch' }}>
          The same trolley can cost R80 more, depending only on where you walk.
        </h2>
        <p style={{ color: 'rgba(243,239,226,0.78)', marginTop: 'var(--s-4)', maxWidth: '56ch', fontSize: 'var(--t-sm)' }}>
          That is most of a day&apos;s food budget, lost to a decision nobody tells you
          how to make. Mintly makes the comparison before you leave res.
        </p>
      </Card>
    </div>
  );
}
