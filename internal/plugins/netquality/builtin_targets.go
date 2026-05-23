package netquality

// builtinTarget is one row that ships with the plugin. The seed runs on
// OnEnable via an INSERT…ON CONFLICT DO NOTHING so re-enabling a host
// after a manual edit (operator added a custom row, disabled a builtin)
// doesn't overwrite the operator's intent.
//
// Targets are public DNS resolvers — they're the only stable IPs we can
// rely on long-term per ISP. Each row maps to one "tile" in the plugin's
// per-server grid: ISP × Region.
type builtinTarget struct {
	ISP    string // telecom | unicom | mobile | overseas
	Region string // free text; grouped client-side
	Label  string // display, e.g. "电信 上海"
	Host   string // IP, never a hostname (eliminates DNS as a variable)
}

// builtinTargets is the curated set of probe destinations. Picked for
// long-term IP stability — every entry has held its address for 5+ years
// per public DNS-resolver registries. NOT exhaustive (NetQuality covers
// 31 provinces × 3 ISPs); these are the representative anchors.
var builtinTargets = []builtinTarget{
	// 中国电信 (China Telecom) — public DNS by province/region
	{"telecom", "Shanghai", "电信 上海", "202.96.209.5"},
	{"telecom", "Beijing", "电信 北京", "219.141.136.10"},
	{"telecom", "Guangdong", "电信 广东", "202.96.128.86"},
	{"telecom", "Sichuan", "电信 四川", "61.139.2.69"},
	{"telecom", "Hubei", "电信 湖北", "202.103.24.68"},

	// 中国联通 (China Unicom)
	{"unicom", "Beijing", "联通 北京", "123.123.123.123"},
	{"unicom", "Shanghai", "联通 上海", "210.22.84.3"},
	{"unicom", "Guangdong", "联通 广东", "210.21.196.6"},
	{"unicom", "Liaoning", "联通 辽宁", "202.96.69.38"},

	// 中国移动 (China Mobile)
	{"mobile", "Beijing", "移动 北京", "211.136.192.6"},
	{"mobile", "Shanghai", "移动 上海", "211.136.150.66"},
	{"mobile", "Guangdong", "移动 广东", "211.139.163.6"},
	{"mobile", "Sichuan", "移动 四川", "211.137.96.205"},

	// Overseas anchors
	{"overseas", "Global", "Cloudflare 1.1.1.1", "1.1.1.1"},
	{"overseas", "US", "Google 8.8.8.8", "8.8.8.8"},
	{"overseas", "Global", "Quad9 9.9.9.9", "9.9.9.9"},
	{"overseas", "Hong Kong", "HK PCCW", "203.80.96.10"},
	{"overseas", "Japan", "Japan IIJ", "210.130.1.40"},
	{"overseas", "Singapore", "Singapore Singtel", "165.21.83.88"},
}
