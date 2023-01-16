import type { Event as SentryEvent, EventProcessor, Hub, Integration } from '@sentry/types';
import { addExceptionMechanism, fill, GLOBAL_OBJ, logger, supportsNativeFetch } from '@sentry/utils';

export type HttpStatusCodeRange = [number, number] | number;
export type HttpRequestTarget = string | RegExp;
interface HttpClientOptions {
  /**
   * HTTP status codes that should be considered failed.
   * This array can contain tuples of `[begin, end]` (both inclusive),
   * single status codes, or a combinations of both
   *
   * Example: [[500, 505], 507]
   * Default: [[500, 599]]
   */
  failedRequestStatusCodes?: HttpStatusCodeRange[];

  /**
   * Targets to track for failed requests.
   * This array can contain strings or regular expressions.
   *
   * Example: ['http://localhost', /api\/.*\/]
   * Default: [/.*\/]
   */
  failedRequestTargets?: HttpRequestTarget[];
}

/** HTTPClient integration creates events for failed client side HTTP requests. */
export class HttpClient implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'HttpClient';

  /**
   * @inheritDoc
   */
  public name: string = HttpClient.id;

  private readonly _options: HttpClientOptions;

  /**
   * Returns current hub.
   */
  private _getCurrentHub?: () => Hub;

  /**
   * @inheritDoc
   *
   * @param options
   */
  public constructor(options?: Partial<HttpClientOptions>) {
    this._options = {
      failedRequestStatusCodes: [[500, 599]],
      failedRequestTargets: [/.*/],
      ...options,
    };
  }

  /**
   * @inheritDoc
   *
   * @param options
   */
  public setupOnce(_: (callback: EventProcessor) => void, getCurrentHub: () => Hub): void {
    this._getCurrentHub = getCurrentHub;
    this._wrapFetch();
    this._wrapXHR();
  }

  /**
   * Interceptor function for fetch requests
   *
   * @param requestInfo The Fetch API request info
   * @param response The Fetch API response
   * @param requestInit The request init object
   */
  private _fetchResponseHandler(requestInfo: RequestInfo, response: Response, requestInit?: RequestInit): void {
    if (this._getCurrentHub && this._shouldCaptureResponse(response.status, response.url)) {
      const request = new Request(requestInfo, requestInit);
      const hub = this._getCurrentHub();

      let requestHeaders, responseHeaders, requestCookies, responseCookies;

      if (hub.shouldSendDefaultPii()) {
        [{ headers: requestHeaders, cookies: requestCookies }, { headers: responseHeaders, cookies: responseCookies }] =
          [
            { cookieHeader: 'Cookie', obj: request },
            { cookieHeader: 'Set-Cookie', obj: response },
          ].map(({ cookieHeader, obj }) => {
            const headers = this._extractFetchHeaders(obj.headers);
            let cookies;

            try {
              const cookieString = headers[cookieHeader] || headers[cookieHeader.toLowerCase()] || undefined;

              if (cookieString) {
                cookies = this._parseCookieString(cookieString);
              }
            } catch (e) {
              __DEBUG_BUILD__ && logger.log(`Could not extract cookies from header ${cookieHeader}`);
            }

            return {
              headers,
              cookies,
            };
          });
      }

      const event = this._createEvent({
        url: request.url,
        method: request.method,
        status: response.status,
        requestHeaders,
        responseHeaders,
        requestCookies,
        responseCookies,
      });

      hub.captureEvent(event);
    }
  }

  /**
   * Interceptor function for XHR requests
   *
   * @param xhr The XHR request
   * @param method The HTTP method
   * @param headers The HTTP headers
   */
  private _xhrResponseHandler(xhr: XMLHttpRequest, method: string, headers: Record<string, string>): void {
    if (this._getCurrentHub && this._shouldCaptureResponse(xhr.status, xhr.responseURL)) {
      let requestHeaders, responseCookies, responseHeaders;
      const hub = this._getCurrentHub();

      if (hub.shouldSendDefaultPii()) {
        try {
          const cookieString = xhr.getResponseHeader('Set-Cookie') || xhr.getResponseHeader('set-cookie') || undefined;

          if (cookieString) {
            responseCookies = this._parseCookieString(cookieString);
          }
        } catch (e) {
          __DEBUG_BUILD__ && logger.log('Could not extract cookies from response headers');
        }

        try {
          responseHeaders = this._getXHRResponseHeaders(xhr);
        } catch (e) {
          __DEBUG_BUILD__ && logger.log('Could not extract headers from response');
        }

        requestHeaders = headers;
      }

      const event = this._createEvent({
        url: xhr.responseURL,
        method: method,
        status: xhr.status,
        requestHeaders,
        // Can't access request cookies from XHR
        responseHeaders,
        responseCookies,
      });

      hub.captureEvent(event);
    }
  }

  /**
   * Extracts response size from `Content-Length` header when possible
   *
   * @param headers
   * @returns The response size in bytes or undefined
   */
  private _getResponseSizeFromHeaders(headers?: Record<string, string>): number | undefined {
    if (headers) {
      const contentLength = headers['Content-Length'] || headers['content-length'];

      if (contentLength) {
        return parseInt(contentLength, 10);
      }
    }

    return undefined;
  }

  /**
   * Creates an object containing cookies from the given cookie string
   *
   * @param cookieString The cookie string to parse
   * @returns The parsed cookies
   */
  private _parseCookieString(cookieString: string): Record<string, string> {
    return cookieString.split('; ').reduce((acc: Record<string, string>, cookie: string) => {
      const [key, value] = cookie.split('=');
      acc[key] = value;
      return acc;
    }, {});
  }

  /**
   * Extracts the headers as an object from the given Fetch API request or response object
   *
   * @param headers The headers to extract
   * @returns The extracted headers as an object
   */
  private _extractFetchHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};

    headers.forEach((value, key) => {
      result[key] = value;
    });

    return result;
  }

  /**
   * Extracts the response headers as an object from the given XHR object
   *
   * @param xhr The XHR object to extract the response headers from
   * @returns The response headers as an object
   */
  private _getXHRResponseHeaders(xhr: XMLHttpRequest): Record<string, string> {
    const headers = xhr.getAllResponseHeaders();

    if (!headers) {
      return {};
    }

    return headers.split('\r\n').reduce((acc: Record<string, string>, line: string) => {
      const [key, value] = line.split(': ');
      acc[key] = value;
      return acc;
    }, {});
  }

  /**
   * Checks if the given target url is in the given list of targets
   *
   * @param target The target url to check
   * @returns true if the target url is in the given list of targets, false otherwise
   */
  private _isInGivenRequestTargets(target: string): boolean {
    if (!this._options.failedRequestTargets) {
      return false;
    }

    return this._options.failedRequestTargets.some((givenRequestTarget: HttpRequestTarget) => {
      if (typeof givenRequestTarget === 'string') {
        return target.includes(givenRequestTarget);
      }

      return givenRequestTarget.test(target);
    });
  }

  /**
   * Checks if the given status code is in the given range
   *
   * @param status The status code to check
   * @returns true if the status code is in the given range, false otherwise
   */
  private _isInGivenStatusRanges(status: number): boolean {
    if (!this._options.failedRequestStatusCodes) {
      return false;
    }

    return this._options.failedRequestStatusCodes.some((range: HttpStatusCodeRange) => {
      if (typeof range === 'number') {
        return range === status;
      }

      return status >= range[0] && status <= range[1];
    });
  }

  /**
   * Wraps `fetch` function to capture request and response data
   */
  private _wrapFetch(): void {
    if (!supportsNativeFetch()) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    fill(GLOBAL_OBJ, 'fetch', function (originalFetch: (...args: unknown[]) => Promise<Response>) {
      return function (this: Window, ...args: unknown[]): Promise<Response> {
        const [requestInfo, requestInit] = args as [RequestInfo, RequestInit | undefined];
        const responsePromise: Promise<Response> = originalFetch.apply(this, args);

        responsePromise
          .then((response: Response) => {
            self._fetchResponseHandler(requestInfo, response, requestInit);
            return response;
          })
          .catch((error: Error) => {
            throw error;
          });

        return responsePromise;
      };
    });
  }

  /**
   * Wraps XMLHttpRequest to capture request and response data
   */
  private _wrapXHR(): void {
    if (!('XMLHttpRequest' in GLOBAL_OBJ)) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    fill(XMLHttpRequest.prototype, 'open', function (originalOpen: (...openArgs: unknown[]) => void): () => void {
      return function (this: XMLHttpRequest, ...openArgs: unknown[]): void {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const xhr = this;
        const method = openArgs[0] as string;
        const headers: Record<string, string> = {};

        // Intercepting `setRequestHeader` to access the request headers of XHR instance.
        // This will only work for user/library defined headers, not for the default/browser-assigned headers.
        // Request cookies are also unavailable for XHR, as `Cookie` header can't be defined by `setRequestHeader`.
        fill(
          xhr,
          'setRequestHeader',
          // eslint-disable-next-line @typescript-eslint/ban-types
          function (originalSetRequestHeader: (...setRequestHeaderArgs: unknown[]) => void): Function {
            return function (...setRequestHeaderArgs: unknown[]): void {
              const [header, value] = setRequestHeaderArgs as [string, string];

              headers[header] = value;

              return originalSetRequestHeader.apply(xhr, setRequestHeaderArgs);
            };
          },
        );

        // eslint-disable-next-line @typescript-eslint/ban-types
        fill(xhr, 'onloadend', function (original?: (...onloadendArgs: unknown[]) => void): Function {
          return function (...onloadendArgs: unknown[]): void {
            try {
              self._xhrResponseHandler(xhr, method, headers);
            } catch (e) {
              __DEBUG_BUILD__ && logger.warn('Error while extracting response event form XHR response', e);
            }

            if (original) {
              return original.apply(xhr, onloadendArgs);
            }
          };
        });

        return originalOpen.apply(this, openArgs);
      };
    });
  }

  /**
   * Checks whether given url points to Sentry server
   *
   * @param url url to verify
   */
  private _isSentryRequest(url: string): boolean {
    const client = this._getCurrentHub && this._getCurrentHub().getClient();

    if (!client) {
      return false;
    }

    const dsn = client.getDsn();
    return dsn ? url.includes(dsn.host) : false;
  }

  /**
   * Checks whether to capture given response as an event
   *
   * @param status response status code
   * @param url response url
   */
  private _shouldCaptureResponse(status: number, url: string): boolean {
    return this._isInGivenStatusRanges(status) && this._isInGivenRequestTargets(url) && !this._isSentryRequest(url);
  }

  /**
   * Creates a synthetic Sentry event from given response data
   *
   * @param data response data
   * @returns event
   */
  private _createEvent(data: {
    url: string;
    method: string;
    status: number;
    responseHeaders?: Record<string, string>;
    responseCookies?: Record<string, string>;
    requestHeaders?: Record<string, string>;
    requestCookies?: Record<string, string>;
  }): SentryEvent {
    const message = `HTTP Client Error with status code: ${data.status}`;

    const event: SentryEvent = {
      message,
      exception: {
        values: [
          {
            type: 'Error',
            value: message,
          },
        ],
      },
      request: {
        url: data.url,
        method: data.method,
        headers: data.requestHeaders,
        cookies: data.requestCookies,
      },
      contexts: {
        response: {
          status_code: data.status,
          headers: data.responseHeaders,
          cookies: data.responseCookies,
          body_size: this._getResponseSizeFromHeaders(data.responseHeaders),
        },
      },
    };

    addExceptionMechanism(event, {
      type: 'http.client',
    });

    return event;
  }
}