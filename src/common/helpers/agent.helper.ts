import * as http from 'http';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export interface HttpAgentsPair {
  httpAgent: http.Agent | HttpsProxyAgent<string> | SocksProxyAgent;
  httpsAgent: https.Agent | HttpsProxyAgent<string> | SocksProxyAgent;
}

/**
 * Creates appropriate proxy or default HTTP/HTTPS agents
 */
export function createProxyAgent(
  proxyUrl?: string | null,
  isHttps: boolean = true,
): http.Agent | https.Agent | HttpsProxyAgent<string> | SocksProxyAgent {
  if (proxyUrl) {
    return proxyUrl.startsWith('socks')
      ? new SocksProxyAgent(proxyUrl)
      : new HttpsProxyAgent(proxyUrl);
  }

  return isHttps
    ? new https.Agent({ keepAlive: false, rejectUnauthorized: false })
    : new http.Agent({ keepAlive: false });
}

/**
 * Creates a pair of httpAgent and httpsAgent for axios requests
 */
export function createHttpAgents(proxyUrl?: string | null): HttpAgentsPair {
  if (proxyUrl) {
    const agent = proxyUrl.startsWith('socks')
      ? new SocksProxyAgent(proxyUrl)
      : new HttpsProxyAgent(proxyUrl);
    return {
      httpAgent: agent,
      httpsAgent: agent,
    };
  }

  return {
    httpAgent: new http.Agent({ keepAlive: false }),
    httpsAgent: new https.Agent({ keepAlive: false, rejectUnauthorized: false }),
  };
}
