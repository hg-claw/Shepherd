// internal/agentapi/pty.go
package agentapi

const (
	TypePTYOpen   = "pty.open"
	TypePTYResize = "pty.resize"
	TypePTYClose  = "pty.close"
	TypePTYExit   = "pty.exit"

	PTYKindConsole = "console"
	PTYKindScript  = "script"
)

type PTYOpen struct {
	Sid      string            `json:"sid"`
	Kind     string            `json:"kind"`
	User     string            `json:"user"`
	Rows     int               `json:"rows"`
	Cols     int               `json:"cols"`
	Term     string            `json:"term"`
	Exec     string            `json:"exec,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
	TimeoutS int               `json:"timeout_s,omitempty"`
}

type PTYResize struct {
	Sid  string `json:"sid"`
	Rows int    `json:"rows"`
	Cols int    `json:"cols"`
}

type PTYClose struct {
	Sid    string `json:"sid"`
	Reason string `json:"reason,omitempty"`
}

type PTYExit struct {
	Sid  string `json:"sid"`
	Code int    `json:"code"`
}
