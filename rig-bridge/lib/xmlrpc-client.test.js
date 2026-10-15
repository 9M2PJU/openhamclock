/**
 * xmlrpc-client — encode/decode round-trips and the injectable transport.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { encodeCall, encodeValue, decodeResponse, createXmlRpcClient } from './xmlrpc-client.js';

const response = (inner) =>
  `<?xml version="1.0"?><methodResponse><params><param>${inner}</param></params></methodResponse>`;

describe('xmlrpc encode', () => {
  it('encodes scalars with the right XML-RPC types', () => {
    expect(encodeValue(42)).toBe('<value><int>42</int></value>');
    expect(encodeValue(14.074)).toBe('<value><double>14.074</double></value>');
    expect(encodeValue(true)).toBe('<value><boolean>1</boolean></value>');
    expect(encodeValue(null)).toBe('<value><nil/></value>');
    expect(encodeValue('a<b&c')).toBe('<value><string>a&lt;b&amp;c</string></value>');
    expect(encodeValue(Buffer.from('hi'))).toBe('<value><base64>aGk=</base64></value>');
  });

  it('encodes arrays and structs', () => {
    expect(encodeValue(['x', 1])).toBe(
      '<value><array><data><value><string>x</string></value><value><int>1</int></value></data></array></value>',
    );
    expect(encodeValue({ k: 'v' })).toBe(
      '<value><struct><member><name>k</name><value><string>v</string></value></member></struct></value>',
    );
  });

  it('builds a methodCall document', () => {
    expect(encodeCall('modem.set_by_name', ['BPSK31'])).toBe(
      '<?xml version="1.0"?><methodCall><methodName>modem.set_by_name</methodName><params><param><value><string>BPSK31</string></value></param></params></methodCall>',
    );
    expect(encodeCall('main.rx')).toContain('<params></params>');
  });
});

describe('xmlrpc decode', () => {
  it('decodes scalar responses', () => {
    expect(decodeResponse(response('<value><double>14070000</double></value>'))).toBe(14070000);
    expect(decodeResponse(response('<value><int>12</int></value>'))).toBe(12);
    expect(decodeResponse(response('<value><i4>-3</i4></value>'))).toBe(-3);
    expect(decodeResponse(response('<value><string>BPSK31</string></value>'))).toBe('BPSK31');
    expect(decodeResponse(response('<value>untyped &amp; text</value>'))).toBe('untyped & text');
    expect(decodeResponse(response('<value><boolean>1</boolean></value>'))).toBe(true);
    expect(decodeResponse(response('<value><nil/></value>'))).toBeNull();
  });

  it('decodes base64 into a Buffer (fldigi text getters return bytes)', () => {
    const v = decodeResponse(response('<value><base64>Q1EgQ1EgZGUgS0U4UExN\n</base64></value>'));
    expect(Buffer.isBuffer(v)).toBe(true);
    expect(v.toString('utf8')).toBe('CQ CQ de KE8PLM');
  });

  it('decodes nested arrays and structs', () => {
    const xml = response(
      '<value><array><data><value><string>BPSK31</string></value><value><struct><member><name>n</name><value><int>1</int></value></member><member><name>list</name><value><array><data><value><string>a</string></value></data></array></value></member></struct></value></data></array></value>',
    );
    expect(decodeResponse(xml)).toEqual(['BPSK31', { n: 1, list: ['a'] }]);
  });

  it('returns null for an empty params response', () => {
    expect(decodeResponse('<?xml version="1.0"?><methodResponse><params></params></methodResponse>')).toBeNull();
  });

  it('throws on a fault with code and string attached', () => {
    const xml =
      '<methodResponse><fault><value><struct><member><name>faultCode</name><value><int>1</int></value></member><member><name>faultString</name><value><string>no such method</string></value></member></struct></value></fault></methodResponse>';
    expect(() => decodeResponse(xml)).toThrow(/no such method/);
    try {
      decodeResponse(xml);
    } catch (e) {
      expect(e.faultCode).toBe(1);
      expect(e.faultString).toBe('no such method');
    }
  });

  it('rejects non-XML-RPC bodies', () => {
    expect(() => decodeResponse('<html>nope</html>')).toThrow(/Not an XML-RPC/);
  });
});

// A fake http.request that records the call and replies with a canned body.
function fakeRequest(reply, { status = 200, fail = null } = {}) {
  const seen = [];
  const request = (options, onResponse) => {
    const req = new EventEmitter();
    let body = '';
    req.setTimeout = () => {};
    req.write = (chunk) => {
      body += chunk;
    };
    req.destroy = (err) => req.emit('error', err);
    req.end = () => {
      seen.push({ options, body });
      if (fail) return setImmediate(() => req.emit('error', fail));
      const res = new EventEmitter();
      res.statusCode = status;
      setImmediate(() => {
        onResponse(res);
        res.emit('data', Buffer.from(typeof reply === 'function' ? reply(body) : reply));
        res.emit('end');
      });
    };
    return req;
  };
  return { request, seen };
}

describe('createXmlRpcClient transport', () => {
  it('POSTs a methodCall to /RPC2 and resolves the decoded value', async () => {
    const { request, seen } = fakeRequest(response('<value><string>CW</string></value>'));
    const client = createXmlRpcClient('http://127.0.0.1:7362', { request });
    await expect(client.call('modem.get_name')).resolves.toBe('CW');
    expect(seen).toHaveLength(1);
    expect(seen[0].options).toMatchObject({ hostname: '127.0.0.1', port: '7362', path: '/RPC2', method: 'POST' });
    expect(seen[0].body).toContain('<methodName>modem.get_name</methodName>');
  });

  it('rejects on HTTP errors, faults and socket errors', async () => {
    const bad = fakeRequest('oops', { status: 500 });
    await expect(createXmlRpcClient('http://h:1', { request: bad.request }).call('x')).rejects.toThrow(/HTTP 500/);

    const fault = fakeRequest(
      '<methodResponse><fault><value><struct><member><name>faultString</name><value><string>bad</string></value></member></struct></value></fault></methodResponse>',
    );
    await expect(createXmlRpcClient('http://h:1', { request: fault.request }).call('x')).rejects.toThrow(/bad/);

    const dead = fakeRequest('', { fail: new Error('ECONNREFUSED') });
    await expect(createXmlRpcClient('http://h:1', { request: dead.request }).call('x')).rejects.toThrow(/ECONNREFUSED/);
  });
});
