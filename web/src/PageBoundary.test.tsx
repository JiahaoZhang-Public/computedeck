import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { PageBoundary } from './PageBoundary';

describe('page boundary', () => {
  it('shows an error in place of a page that failed and clears it on another page', () => {
    const boundary = new PageBoundary({ page: 'sources', children: 'page' });
    boundary.state = PageBoundary.getDerivedStateFromError(new Error('bad value'));
    const html = renderToStaticMarkup(boundary.render() as ReactElement);
    expect(html).toContain('This page could not be shown');
    expect(html).toContain('Retry');
    let cleared = false;
    boundary.setState = () => {
      cleared = true;
    };
    Object.assign(boundary, { props: { page: 'overview', children: 'page' } });
    boundary.componentDidUpdate({ page: 'sources', children: 'page' });
    expect(cleared).toBe(true);
  });
});
