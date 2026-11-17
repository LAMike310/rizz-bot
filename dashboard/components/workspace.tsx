'use client';

import {useEffect, useState, type ReactNode} from 'react';

const storageKey = 'rizz-sidebar';

export function Workspace({children}: {children: ReactNode}) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.sessionStorage.getItem(storageKey) === 'collapsed');
  }, []);

  function toggle() {
    setCollapsed((current) => {
      const next = !current;
      window.sessionStorage.setItem(storageKey, next ? 'collapsed' : 'open');
      return next;
    });
  }

  return (
    <div className="workspace" data-sidebar={collapsed ? 'collapsed' : 'open'}>
      {children}
      <button
        type="button"
        className="sidebar-toggle"
        aria-pressed={collapsed}
        aria-controls="content"
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="visually-hidden">{collapsed ? 'Show conversations' : 'Hide conversations'}</span>
      </button>
    </div>
  );
}
