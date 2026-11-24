import { observable } from 'mobx';

/**
 * @@@page-modal — the session page is showing a view as a modal (App 市场, an App's page), drawn by the workspace. The shell
 * reads it to lift the session frame above itself while it is open, as Settings is (MainLayout); set only by the workspace.
 */
export const pageModalOpen = observable.box(false);
