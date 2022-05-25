import { nextTick } from '../next-tick'

let isInit = true

class WebIntersectionObserver {
  constructor (_component, options) {
    this._component = _component
    this._options = options || {}
    this._relativeInfo = []
    this._callback = null
    this._observer = null
    this._root = null
    this._rootMargin = ''
    this._disconnected = false
  }

  initObserver () {
    if (this._observer) {
      this._observer = null
    }
    this._disconnected = false
    // eslint-disable-next-line no-undef
    return new IntersectionObserver((entries, observer) => {
      const initialRatio = this._options.initialRatio || 0
      const thresholds = this._options.thresholds || [0]
      const thresholdsSortArr = thresholds.sort((a, b) => {
        return a - b
      })
      const minThreshold = thresholdsSortArr[0]
      entries.forEach(entry => {
        if (!isInit || (isInit && (entry.intersectionRatio !== initialRatio && (minThreshold <= entry.intersectionRatio)))) {
          Object.defineProperties(entry, {
            id: {
              value: entry.target.getAttribute('id') || '',
              writable: false,
              enumerable: true,
              configurable: true
            },
            dataset: {
              value: entry.target.dataset || {},
              writable: false,
              enumerable: true,
              configurable: true
            },
            relativeRect: {
              value: entry.rootBounds || {},
              writable: false,
              enumerable: true,
              configurable: true
            },
            time: {
              value: new Date().valueOf(),
              writable: false,
              enumerable: true,
              configurable: true
            }
          })
          this._callback && this._callback(entry)
        }
      })
      isInit = false
    }, {
      root: this._root || null,
      rootMargin: this._rootMargin,
      threshold: this._options.thresholds || [0]
    })
  }

  observe (targetSelector, callback) {
    nextTick(async () => {
      if (!targetSelector) {
        const res = { errMsg: 'observe:targetSelector can not be empty' }
        return Promise.reject(res)
      }
      this._observer = await this.initObserver()
      this._callback = callback
      let targetElement = []
      if (this._options.observeAll) {
        targetElement = document.querySelectorAll(targetSelector)
      } else {
        targetElement = [document.querySelector(targetSelector)]
      }
      targetElement.forEach((element) => {
        this._observer && this._observer.observe(element)
      })
    })
  }

  relativeTo (selector, margins) {
    nextTick(() => {
      const marginsTemp = margins || {}
      const { left = 0, right = 0, top = 0, bottom = 0 } = marginsTemp
      this._root = document.querySelector(selector)
      this._rootMargin = `${top}px ${right}px ${bottom}px ${left}px`
      this._relativeInfo.push({ selector, margins })
    })
    return this
  }

  relativeToViewport (margins) {
    nextTick(() => {
      const marginsTemp = margins || {}
      const { left = 0, right = 0, top = 0, bottom = 0 } = marginsTemp
      this._root = document.querySelector('html')
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight
      const rootWidth = this._root.offsetWidth || 0
      const rootHeight = this._root.offsetHeight || 0
      if (rootHeight >= viewportHeight) {
        this._rootMargin = `${top}px ${viewportWidth - rootWidth + right}px ${viewportHeight - rootHeight + bottom}px ${left}px`
      } else {
        this._rootMargin = `${top}px ${right}px ${bottom}px ${left}px`
      }
      this._relativeInfo.push({ selector: null, margins })
    })
    return this
  }

  disconnect () {
    this._disconnected = true
    this._observer.disconnect()
  }
}

export default WebIntersectionObserver