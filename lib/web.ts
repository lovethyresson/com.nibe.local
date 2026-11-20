/** One JSON GET over https, with the app's User-Agent. Only the Gateway calls it
 *  (gateway-weather.ts); the collector's place search still does, once per search. */
import https from 'https';

export function getJson(url: string, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {headers: {'User-Agent': 'com.nibe.local (Homey app)'}}, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                if ((response.statusCode ?? 0) >= 400)
                    return reject(Object.assign(new Error(`HTTP ${response.statusCode}`), {statusCode: response.statusCode}));
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error('timed out')));
        request.on('error', reject);
    });
}
