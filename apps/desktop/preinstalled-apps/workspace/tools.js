// The Files App's tools for agents: chat files (folder.mjs — list, edit for rename / move, delete), reached through the
// catalog as workspace__<tool>. Every export here is a tool. A file's content goes in with file_put, out with
// message_download_file.
export { list, edit, delete } from './folder.mjs'
