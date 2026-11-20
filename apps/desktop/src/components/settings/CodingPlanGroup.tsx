import type { ReactNode } from 'react';

/** The provider owns the heading; each connection keeps its original actions and reading. */
export function CodingPlanGroup({ id, name, icon, children }: { id: string; name: string; icon: ReactNode; children: ReactNode }) {
  return <div className="gg-coding-provider" data-coding-provider={id}>
    <h3 className="gg-coding-provider-title">{icon}<span>{name}</span></h3>
    {children}
  </div>;
}
