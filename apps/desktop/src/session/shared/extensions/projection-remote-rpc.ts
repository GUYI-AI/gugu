/** The same authenticated task-page watch on desktop, phone, cloud and SSH. */
export const PROJECTION_REMOTE_RPC = {
  watch: 'appProjection.watch', send: 'appProjection.send', unwatch: 'appProjection.unwatch', control: 'appProjection.pageControl',
} as const;
export const PROJECTION_REMOTE_PACKET = 'appProjection.packet';
export const PROJECTION_REMOTE_PAGE_STATE = 'appProjection.pageState';
