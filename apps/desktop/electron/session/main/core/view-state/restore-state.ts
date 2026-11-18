import { sessionProjectLocations } from '../session-timeline/session-project-locations';

/** Layout repair for the saved screen: where its sessions live. The view state itself reached the renderer before its first frame. */
export function readViewStateForRestore(sessionIds: string[]) {
  return { locations: sessionProjectLocations(sessionIds) };
}
