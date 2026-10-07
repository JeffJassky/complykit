import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { JobMetrics } from '../../shared/api';
import { ScenarioStrip, upcomingScenarios } from './ScenarioStrip';

const planned: NonNullable<JobMetrics['planned']> = [
  { location: 'local', scenario: 'reject' },
  { location: 'local', scenario: 'reject', run: 2 },
  { location: 'local', scenario: 'gpc' },
  { location: 'local', scenario: 'gpc', run: 2 },
];

describe('ScenarioStrip', () => {
  it('names the upcoming visits, repeats marked "slow"', () => {
    const started: JobMetrics['scenarios'] = [
      { location: 'local', scenario: 'reject', status: 'tested' },
      { location: 'local', scenario: 'reject', run: 2, status: 'running' },
    ];
    expect(upcomingScenarios(planned, started)).toEqual(planned.slice(2));
    const html = renderToStaticMarkup(<ScenarioStrip scenarios={started} planned={planned} pending={2} />);
    // Done and running chips: the repeat is distinguishable.
    expect(html).toContain('>Reject<');
    expect(html).toContain('>Reject · slow<');
    expect(html).toContain('sc-running sc-repeat');
    // The next row lists names, not bare dots.
    expect(html).toContain('2 more scenarios planned');
    expect(html).toMatch(/sc-upcoming"[^>]*>.*Do-not-sell signal/);
    expect(html).toContain('Do-not-sell signal · slow');
  });

  it('jobs without a recorded plan keep the unlabelled slots', () => {
    const html = renderToStaticMarkup(<ScenarioStrip scenarios={[]} pending={3} />);
    expect(html).toContain('3 waiting');
    expect(html).not.toContain('sc-upcoming');
  });

  it('hides the next row once nothing is pending', () => {
    const html = renderToStaticMarkup(<ScenarioStrip scenarios={[{ location: 'local', scenario: 'reject', status: 'tested' }]} planned={planned} pending={0} />);
    expect(html).not.toContain('next');
  });
});
