package subgen

import "strings"

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
	n.Name = nodeName(srv.Country, srv.Name, n.Protocol)
	return n
}
