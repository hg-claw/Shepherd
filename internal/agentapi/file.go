// internal/agentapi/file.go
package agentapi

const (
	TypeFileList          = "file.list"
	TypeFileListResult    = "file.list.result"
	TypeFileStat          = "file.stat"
	TypeFileStatResult    = "file.stat.result"
	TypeFileMkdir         = "file.mkdir"
	TypeFileRename        = "file.rename"
	TypeFileRm            = "file.rm"
	TypeFileOpResult      = "file.op.result"
	TypeFileUploadBegin   = "file.upload.begin"
	TypeFileUploadEnd     = "file.upload.end"
	TypeFileUploadAck     = "file.upload.ack"
	TypeFileDownloadBegin = "file.download.begin"
	TypeFileDownloadMeta  = "file.download.meta"
	TypeFileDownloadEnd   = "file.download.end"
	TypeFileCancel        = "file.cancel"
)

type FileEntry struct {
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	Mode       uint32 `json:"mode"`
	MTime      int64  `json:"mtime"` // unix seconds
	IsDir      bool   `json:"is_dir"`
	IsLink     bool   `json:"is_link,omitempty"`
	LinkTarget string `json:"link_target,omitempty"`
}

type FileList struct {
	Sid  string `json:"sid"`
	Path string `json:"path"`
}
type FileListResult struct {
	Sid     string      `json:"sid"`
	Entries []FileEntry `json:"entries,omitempty"`
	Error   string      `json:"error,omitempty"`
}

type FileStat struct {
	Sid  string `json:"sid"`
	Path string `json:"path"`
}
type FileStatResult struct {
	Sid   string     `json:"sid"`
	Entry *FileEntry `json:"entry,omitempty"`
	Error string     `json:"error,omitempty"`
}

type FileMkdir struct {
	Sid  string `json:"sid"`
	Path string `json:"path"`
	Mode uint32 `json:"mode"`
}
type FileRename struct {
	Sid string `json:"sid"`
	Src string `json:"src"`
	Dst string `json:"dst"`
}
type FileRm struct {
	Sid       string `json:"sid"`
	Path      string `json:"path"`
	Recursive bool   `json:"recursive,omitempty"`
}
type FileOpResult struct {
	Sid   string `json:"sid"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type FileUploadBegin struct {
	Sid    string `json:"sid"`
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Mode   uint32 `json:"mode"`
	SHA256 string `json:"sha256,omitempty"`
}
type FileUploadEnd struct {
	Sid        string `json:"sid"`
	TotalBytes int64  `json:"total_bytes"`
	SHA256     string `json:"sha256"`
}
type FileUploadAck FileOpResult

type FileDownloadBegin struct {
	Sid  string `json:"sid"`
	Path string `json:"path"`
}
type FileDownloadMeta struct {
	Sid   string `json:"sid"`
	Size  int64  `json:"size"`
	Mode  uint32 `json:"mode"`
	MTime int64  `json:"mtime"`
	Error string `json:"error,omitempty"`
}
type FileDownloadEnd struct {
	Sid string `json:"sid"`
}
type FileCancel struct {
	Sid    string `json:"sid"`
	Reason string `json:"reason"`
}
