import { useAgentIcon } from '../stores/use-agents';
import { PluginIcon } from './plugin-icon';
import { Unknown } from '@/components/ui/Unknown';
import { cn } from '@renderer/utils/utils';

interface AgentIconProps {
  id: string;
  /** Icon size in pixels. Default: 16. */
  size?: number;
  /** Applied to the outer wrapper span — use for positioning, rounding, overflow, etc. */
  className?: string;
  grayscale?: boolean;
}

export function AgentIcon({ id, size = 16, className, grayscale }: AgentIconProps) {
  const icon = useAgentIcon(id);
  // The icon table not read yet: the icon's place, ❌ nothing (the label would move when the icon lands).
  if (icon === undefined) {
    return <span className={cn('inline-flex shrink-0', className)} style={{ width: size, height: size }}><Unknown className="h-full w-full" /></span>;
  }
  if (!icon) return null;

  return <PluginIcon id={id} icon={icon} size={size} className={className} grayscale={grayscale} />;
}
