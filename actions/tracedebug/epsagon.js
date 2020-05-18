const fetch = require('node-fetch')

const EPSAGON_API_ENDPOINT = 'https://api.epsagon.com'

async function getData(id, token, logger) {
    const res = {
        step: 0
    }

    const currentTime = new Date().getTime()
    let url = EPSAGON_API_ENDPOINT + '/search/query_events?query=' + encodeURIComponent(JSON.stringify({
        'search_string': [{
            'type': 'aws_request_id',
            'term': id
        }],
        'time_frame': {
            'type': 'last_week',
        },
        'sort': {
            'by': 'start_time',
            'direction': 'desc'
        },
    }))

    logger.debug(`url: ${url}`)

    // fetch content from external api endpoint
    let response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`
        }
    })
    if (!response.ok) {
        logger.error('Error while requesting /search', response.body)
        throw new Error(`Request to ${EPSAGON_API_ENDPOINT}/search failed with status code ${response.status}`)
    }

    const resources = await response.json()

    if (resources && resources.length > 0) {
        const spanId = resources[0].span_id
        if (spanId) {
            res.wrapper = resources[0]
            url = EPSAGON_API_ENDPOINT + '/spans/graph?span_id=' + spanId
            response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            })
            if (!response.ok) {
                logger.error('Error while requesting /spans', response.body)
                throw new Error(`Request to ${EPSAGON_API_ENDPOINT}/spans failed with status code ${response.status}`)
            }

            res.step = 2
            res.spans = (await response.json()).data
        } else {
            res.step = 1
        }
    }

    return res
}

// re-order array by parents and by date
const moveToParent = function(results, spans, parentId, level) {
    const spansWithParent = spans.filter((sp) => sp.parentSpanId === parentId)
    spansWithParent.forEach((span) => {
      if (results.length > 0) {
        let to = results.findIndex((s) => s.spanId === parentId) + 1
        while(to < results.length && results[to].parentSpanId === span.parentSpanId && results[to].timestamp < span.timestamp) to++
        results.splice(to, 0, span)
      } else {
        results.push(span)
      }
      span.level = level
      // remove current span from the list
      spans = spans.filter((sp) => sp.spanId !== span.spanId)
    })
    
    spansWithParent.forEach((span) => {
      results = moveToParent(results, spans, span.spanId, level+1)
    })

    return results
  }

function constructSpans(data) {
    let spans = []

    if (data && data.spans) {
        // construct spans list
        data.spans.forEach(container => {
            container.spans.forEach((span) => {
                const tags = span.tags
                let actionName = tags['openwhisk.action.name']
                let invokedName = ''
                if (actionName) {
                    const namespace = tags['openwhisk.namespace']
                    const package = tags['openwhisk.action.package']
                    const version = tags['openwhisk.action.version']
                    invokedName = `/${namespace ? namespace + '/' : ''}${package ? package + '/' : ''}${actionName}${version ? '@' + version : ''}`
                } else {
                    actionName = container.name
                }

                let activationId = tags['openwhisk.action.activation_id']
                const response = tags['openwhisk.action.response']
                if (response
                    && response.result
                    && response.result.headers
                    && response.result.headers['x-last-activation-id']) {
                        // sequences case
                        // use last-activation-id if available
                        activationId = response.result.headers['x-last-activation-id']
                    }
                const params = tags['openwhisk.action.params']
                let host = tags['openwhisk.api_host'];
                if (!host) {
                    if (tags['http.host']) {
                        host = tags['http.scheme'] ? `${tags['http.scheme']}://${tags['http.host']}` : tags['http.host']
                    }
                }

                spans.push({
                    duration: span.duration,
                    error: span.error,
                    activationId,
                    name: actionName,
                    invokedName,
                    operation: span.operation_name,
                    spanId: span.span_id,
                    timestamp: span.start_time * 1000,
                    date: new Date(span.start_time * 1000),
                    params,
                    path: params && params.path ? params.path : ( tags['http.request.path'] ? tags['http.request.path'] : ''),
                    response,
                    parentSpanId: span.references.length > 0 ? span.references[0].spanID : null,
                    status: response && response.result ? response.result.statusCode : (tags.status ? tags.status : ( tags['http.status_code'] ? tags['http.status_code'] : 'N/A')),
                    host, 
                    type: container.type,
                    data: tags.params ? null : tags
                })
            })
        })

        const spansList = []
        spans = moveToParent(spansList, spans, null, 0)
    }

    console.log(spans)
    return spans
}

module.exports = {
    getData,
    constructSpans
}