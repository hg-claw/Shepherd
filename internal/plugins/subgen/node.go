package subgen

import (
	"encoding/json"
	"fmt"
	"strings"
)

type Node struct {
	Name     string
	Protocol string // vless|vmess|trojan|shadowsocks|hysteria2|tuic|anytls
	Server   string
	Port     int
	Country  string

	UUID     string
	Password string
	SNI      string
	Flow     string

	RealityPublicKey string
	RealityShortID   string

	Transport string // ""|ws|grpc|h2|httpupgrade
	Path      string
	Host      string

	SSMethod string
	Insecure bool
	ALPN     []string

	Extra map[string]any
}

type serverLite struct {
	Name    string
	Host    string
	Country string
}

type xrayLite struct {
	Tag        string
	Alias      string
	Port       int
	Protocol   string
	UUID       string
	SNI        string
	PublicKey  string
	ShortID    string
	WSPath     string
	SSMethod   string
	SSPassword string
}

func baseScheme(proto string) string {
	switch {
	case strings.HasPrefix(proto, "vless"):
		return "vless"
	case strings.HasPrefix(proto, "vmess"):
		return "vmess"
	case strings.HasPrefix(proto, "trojan"):
		return "trojan"
	case proto == "hysteria2":
		return "hysteria2"
	case proto == "tuic-v5":
		return "tuic"
	case proto == "anytls":
		return "anytls"
	case proto == "shadowsocks" || proto == "shadowsocks-2022":
		return "shadowsocks"
	default:
		return proto
	}
}

func countryFlag(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	if len(code) != 2 {
		return ""
	}
	r := []rune{}
	for _, c := range code {
		if c < 'A' || c > 'Z' {
			return ""
		}
		r = append(r, 0x1F1E6+(c-'A'))
	}
	return string(r)
}

func nodeName(country, server, proto string) string {
	flag := countryFlag(country)
	if flag != "" {
		return flag + " " + server + " " + proto
	}
	return server + " " + proto
}

// aliasOrDefault returns a trimmed non-empty alias verbatim, else the
// auto-generated "<flag> <server> <proto>" name.
func aliasOrDefault(alias string, srv serverLite, proto string) string {
	if a := strings.TrimSpace(alias); a != "" {
		return a
	}
	return nodeName(srv.Country, srv.Name, proto)
}

// dedupeNodeNames makes Node.Name unique across the slice, in place,
// preserving order. The first occurrence of a name is kept; later
// collisions get " 2", " 3", … A generated suffix never overwrites a name
// that some other node already carries (so an explicit "X 2" survives even
// if two "X" nodes collide).
func dedupeNodeNames(nodes []Node) {
	// Reserve every original name so a generated suffix can't steal one.
	reserved := make(map[string]bool, 2*len(nodes))
	for i := range nodes {
		reserved[nodes[i].Name] = true
	}
	used := make(map[string]bool, 2*len(nodes))
	for i := range nodes {
		name := nodes[i].Name
		if !used[name] {
			used[name] = true
			continue
		}
		for n := 2; ; n++ {
			cand := fmt.Sprintf("%s %d", name, n)
			if !reserved[cand] && !used[cand] {
				nodes[i].Name = cand
				reserved[cand] = true
				used[cand] = true
				break
			}
		}
	}
}

type singboxLite struct {
	Tag              string
	Alias            string
	Port             int
	Protocol         string
	Role             string
	RelayMode        string
	UUID             *string
	Flow             *string
	Password         *string
	SNI              *string
	RealityPublicKey *string
	RealityShortID   *string
	TransportPath    *string
	TransportHost    *string
	SSMethod         *string
	ExtraJSON        *string
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func transportOf(proto string) string {
	switch {
	case strings.Contains(proto, "-ws-"), strings.HasSuffix(proto, "-ws"):
		return "ws"
	case strings.Contains(proto, "-h2-"), strings.HasSuffix(proto, "-h2"):
		return "h2"
	case strings.Contains(proto, "-httpupgrade-"), strings.HasSuffix(proto, "-httpupgrade"):
		return "httpupgrade"
	default:
		return ""
	}
}

func singboxInboundToNode(in singboxLite, srv serverLite) Node {
	n := Node{
		Protocol:  baseScheme(in.Protocol),
		Server:    srv.Host,
		Port:      in.Port,
		Country:   srv.Country,
		UUID:      deref(in.UUID),
		Password:  deref(in.Password),
		SNI:       deref(in.SNI),
		Flow:      deref(in.Flow),
		SSMethod:  deref(in.SSMethod),
		Transport: transportOf(in.Protocol),
		Path:      deref(in.TransportPath),
		Host:      deref(in.TransportHost),
	}
	if in.Protocol == "vless-reality" {
		n.RealityPublicKey = deref(in.RealityPublicKey)
		n.RealityShortID = deref(in.RealityShortID)
	}
	if e := deref(in.ExtraJSON); e != "" {
		var m map[string]any
		if json.Unmarshal([]byte(e), &m) == nil {
			n.Extra = m
		}
	}
	n.Name = aliasOrDefault(in.Alias, srv, n.Protocol)
	return n
}

func xrayInboundToNode(in xrayLite, srv serverLite) Node {
	n := Node{
		Protocol: baseScheme(in.Protocol),
		Server:   srv.Host,
		Port:     in.Port,
		Country:  srv.Country,
		UUID:     in.UUID,
		SNI:      in.SNI,
	}
	switch in.Protocol {
	case "vless-reality":
		n.RealityPublicKey = in.PublicKey
		n.RealityShortID = in.ShortID
	case "vmess-ws":
		n.Transport = "ws"
		n.Path = in.WSPath
	case "shadowsocks":
		n.SSMethod = in.SSMethod
		n.Password = in.SSPassword
	}
	n.Name = aliasOrDefault(in.Alias, srv, n.Protocol)
	return n
}
