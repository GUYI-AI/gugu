export type FileFamily = 'pdf' | 'word' | 'sheet' | 'slides' | 'archive' | 'image' | 'video' | 'audio' | 'code' | 'text' | 'other'
export declare function fileFamily(name: string | null | undefined, mime?: string | null): FileFamily
