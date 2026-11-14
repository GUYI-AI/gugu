import { describe, expect, it } from 'vitest'
import { previewRootFor, previewUrl, resolvePreviewRequest } from './preview-url'
import { isOutsideWorkspace, resolveWorkspaceResourcePath } from '../../renderer/lib/editor/workspace-resource-path'

describe('filesystem-root workspaces', () => {
  it('resolves Windows absolute resource paths within the existing document rules', () => {
    const inside = { workspacePath: 'C:/work', containingFilePath: 'C:/work/note.html' }
    expect(resolveWorkspaceResourcePath({ ...inside, resourcePath: 'C:/work/image.png' })).toBe('C:/work/image.png')
    expect(resolveWorkspaceResourcePath({ ...inside, resourcePath: 'C:\\work\\image.png' })).toBe('C:/work/image.png')
    expect(resolveWorkspaceResourcePath({ ...inside, resourcePath: 'C:/outside/image.png' })).toBeNull()
    expect(resolveWorkspaceResourcePath({ ...inside, resourcePath: 'D:/work/image.png' })).toBeNull()
    expect(resolveWorkspaceResourcePath({ ...inside, resourcePath: 'https://example.test/image.png' })).toBeNull()
    expect(resolveWorkspaceResourcePath({ workspacePath: 'C:/work', containingFilePath: 'D:/notes/note.html', resourcePath: 'E:/image.png' })).toBe('E:/image.png')
  })
  it('accepts single backslash drive paths and keeps the workspace boundary', () => {
    const inside = { workspacePath: String.raw`C:\work`, containingFilePath: String.raw`C:\work\note.html` }
    expect(resolveWorkspaceResourcePath({ ...inside, resourcePath: String.raw`C:\work\image.png` })).toBe('C:/work/image.png')
    expect(resolveWorkspaceResourcePath({ ...inside, resourcePath: String.raw`C:\outside\image.png` })).toBeNull()
    expect(resolveWorkspaceResourcePath({ ...inside, resourcePath: String.raw`D:\work\image.png` })).toBeNull()
    expect(resolveWorkspaceResourcePath({ ...inside, containingFilePath: String.raw`D:\notes\note.html`, resourcePath: String.raw`E:\image.png` })).toBe('E:/image.png')
  })
  it.each([['/', '/note.html', '/image.png'], ['C:/', 'C:/note.html', 'C:/image.png']])('retains %s as a workspace root', (workspacePath, documentPath, imagePath) => {
    const root = previewRootFor(workspacePath, documentPath)
    expect(root.kind).toBe('workspace')
    expect(previewUrl('page', root, documentPath)).toBe('gugu-preview://page/note.html')
    expect(resolvePreviewRequest(root, '/image.png')).toBe(imagePath)
    expect(resolveWorkspaceResourcePath({ workspacePath, containingFilePath: documentPath, resourcePath: 'image.png' })).toBe(imagePath)
    expect(isOutsideWorkspace(workspacePath, documentPath)).toBe(false)
  })
})
