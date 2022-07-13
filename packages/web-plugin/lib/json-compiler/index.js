const async = require('async')
const JSON5 = require('json5')
const path = require('path')
const parseComponent = require('../parser')
const config = require('../config')
const parseRequest = require('../utils/parse-request')
const evalJSONJS = require('../utils/eval-json-js')
const fixUsingComponent = require('../utils/fix-using-component')
const getRulesRunner = require('../platform/index')
const addQuery = require('../utils/add-query')
const getJSONContent = require('../utils/get-json-content')
const createHelpers = require('../helpers')
const createJSONHelper = require('./helper')
const RecordGlobalComponentsDependency = require('../dependencies/RecordGlobalComponentsDependency')
const RecordIndependentDependency = require('../dependencies/RecordIndependentDependency')
const { MPX_DISABLE_EXTRACTOR_CACHE, RESOLVE_IGNORED_ERR, JSON_JS_EXT } = require('../utils/const')
const resolve = require('../utils/resolve')

module.exports = function (content) {
  const nativeCallback = this.async()
  const mpx = this.getMpx()

  if (!mpx) {
    return nativeCallback(null, content)
  }
  // json模块必须每次都创建（但并不是每次都需要build），用于动态添加编译入口，传递信息以禁用父级extractor的缓存
  this.emitFile(MPX_DISABLE_EXTRACTOR_CACHE, '', undefined, { skipEmit: true })

  // 微信插件下要求组件使用相对路径
  const useRelativePath = mpx.isPluginMode || mpx.useRelativePath
  const { resourcePath, queryObj } = parseRequest(this.resource)
  const useJSONJS = queryObj.useJSONJS || this.resourcePath.endsWith(JSON_JS_EXT)
  const packageName = queryObj.packageRoot || mpx.currentPackageRoot || 'main'
  const pagesMap = mpx.pagesMap
  const componentsMap = mpx.componentsMap[packageName]
  const appInfo = mpx.appInfo
  const mode = mpx.mode
  const env = mpx.env
  const globalSrcMode = mpx.srcMode
  const localSrcMode = queryObj.mode
  const srcMode = localSrcMode || globalSrcMode

  const isApp = !(pagesMap[resourcePath] || componentsMap[resourcePath])
  const publicPath = this._compilation.outputOptions.publicPath || ''
  const fs = this._compiler.inputFileSystem

  const emitWarning = (msg) => {
    this.emitWarning(
      new Error('[json compiler][' + this.resource + ']: ' + msg)
    )
  }

  const emitError = (msg) => {
    this.emitError(
      new Error('[json compiler][' + this.resource + ']: ' + msg)
    )
  }

  const {
    isUrlRequest,
    urlToRequest,
    processPage,
    processDynamicEntry,
    processComponent,
    processJsExport
  } = createJSONHelper({
    loaderContext: this,
    emitWarning,
    emitError
  })

  const { getRequestString } = createHelpers(this)

  let currentName

  if (isApp) {
    currentName = appInfo.name
  } else {
    currentName = componentsMap[resourcePath] || pagesMap[resourcePath]
  }

  const relativePath = useRelativePath ? publicPath + path.dirname(currentName) : ''

  const copydir = (dir, context, callback) => {
    fs.readdir(dir, (err, files) => {
      if (err) return callback(err)
      async.each(files, (file, callback) => {
        file = path.join(dir, file)
        async.waterfall([
          (callback) => {
            fs.stat(file, callback)
          },
          (stats, callback) => {
            if (stats.isDirectory()) {
              copydir(file, context, callback)
            } else {
              fs.readFile(file, (err, content) => {
                if (err) return callback(err)
                if (!this._compilation) return callback()
                let targetPath = path.relative(context, file)
                this._compilation.assets[targetPath] = {
                  size: function size () {
                    return stats.size
                  },
                  source: function source () {
                    return content
                  }
                }
                callback()
              })
            }
          }
        ], callback)
      }, callback)
    })
  }

  const callback = (err, processOutput) => {
    if (err) return nativeCallback(err)
    let output = `var json = ${JSON.stringify(json, null, 2)};\n`
    if (processOutput) output = processOutput(output)
    output += `module.exports = JSON.stringify(json, null, 2);\n`
    nativeCallback(null, output)
  }

  let json
  try {
    if (useJSONJS) {
      json = evalJSONJS(content, this.resourcePath, this)
    } else {
      json = JSON5.parse(content || '{}')
    }
  } catch (err) {
    return callback(err)
  }

  // json补全
  if (pagesMap[resourcePath]) {
    // page
    if (!mpx.forceUsePageCtor) {
      if (!json.usingComponents) {
        json.usingComponents = {}
      }
    }
  } else if (componentsMap[resourcePath]) {
    // component
    if (json.component !== true) {
      json.component = true
    }
  }

  if (json.usingComponents) {
    // todo 迁移到rulesRunner中进行
    fixUsingComponent(json.usingComponents, mode, emitWarning)
  }

  // 快应用补全json配置，必填项
  if (mode === 'qa' && isApp) {
    const defaultConf = {
      package: '',
      name: '',
      icon: 'assets/images/logo.png',
      versionName: '',
      versionCode: 1,
      minPlatformVersion: 1080
    }
    json = Object.assign({}, defaultConf, json)
  }

  const rulesRunnerOptions = {
    mode,
    mpx,
    srcMode,
    type: 'json',
    waterfall: true,
    warn: emitWarning,
    error: emitError
  }
  if (!isApp) {
    rulesRunnerOptions.mainKey = pagesMap[resourcePath] ? 'page' : 'component'
    // polyfill global usingComponents
    // todo 传入rulesRunner中进行按平台转换
    rulesRunnerOptions.data = {
      globalComponents: mpx.usingComponents
    }
  } else {
    // 保存全局注册组件
    if (json.usingComponents) {
      this._module.addPresentationalDependency(new RecordGlobalComponentsDependency(json.usingComponents, this.context))
    }
  }

  const rulesRunner = getRulesRunner(rulesRunnerOptions)

  if (rulesRunner) {
    rulesRunner(json)
  }

  const processComponents = (components, context, callback) => {
    if (components) {
      async.eachOf(components, (component, name, callback) => {
        processComponent(component, context, { relativePath }, (err, entry) => {
          if (err === RESOLVE_IGNORED_ERR) {
            delete components[name]
            return callback()
          }
          if (err) return callback(err)
          components[name] = entry
          callback()
        })
      }, callback)
    } else {
      callback()
    }
  }

  if (isApp) {
    // app.json
    const localPages = []
    const subPackagesCfg = {}
    const pageKeySet = new Set()

    const processPages = (pages, context, tarRoot = '', callback) => {
      if (pages) {
        async.each(pages, (page, callback) => {
          processPage(page, context, tarRoot, (err, entry, { isFirst, key } = {}) => {
            if (err) return callback(err === RESOLVE_IGNORED_ERR ? null : err)
            if (pageKeySet.has(key)) return callback()
            pageKeySet.add(key)
            if (tarRoot && subPackagesCfg) {
              subPackagesCfg[tarRoot].pages.push(entry)
            } else {
              // 确保首页
              if (isFirst) {
                localPages.unshift(entry)
              } else {
                localPages.push(entry)
              }
            }
            callback()
          })
        }, callback)
      } else {
        callback()
      }
    }

    const processPackages = (packages, context, callback) => {
      if (packages) {
        async.each(packages, (packagePath, callback) => {
          const { queryObj } = parseRequest(packagePath)
          async.waterfall([
            (callback) => {
              resolve(context, packagePath, this, (err, result) => {
                if (err) return callback(err)
                const { rawResourcePath } = parseRequest(result)
                callback(err, rawResourcePath)
              })
            },
            (result, callback) => {
              fs.readFile(result, (err, content) => {
                if (err) return callback(err)
                callback(err, result, content.toString('utf-8'))
              })
            },
            (result, content, callback) => {
              const extName = path.extname(result)
              if (extName === '.mpx') {
                const parts = parseComponent(content, {
                  filePath: result,
                  needMap: this.sourceMap,
                  mode,
                  env
                })
                // 对于通过.mpx文件声明的独立分包，默认将其自身的script block视为init module
                if (queryObj.independent === true) queryObj.independent = result
                getJSONContent(parts.json || {}, this, (err, content) => {
                  callback(err, result, content)
                })
              } else {
                callback(null, result, content)
              }
            },
            (result, content, callback) => {
              try {
                content = JSON5.parse(content)
              } catch (err) {
                return callback(err)
              }

              const processSelfQueue = []
              const context = path.dirname(result)

              if (content.pages) {
                let tarRoot = queryObj.root
                if (tarRoot) {
                  delete queryObj.root
                  let subPackage = {
                    tarRoot,
                    pages: content.pages,
                    ...queryObj
                  }

                  if (content.plugins) {
                    subPackage.plugins = content.plugins
                  }

                  processSelfQueue.push((callback) => {
                    processSubPackage(subPackage, context, callback)
                  })
                } else {
                  processSelfQueue.push((callback) => {
                    processPages(content.pages, context, '', callback)
                  })
                }
              }
              if (content.packages) {
                processSelfQueue.push((callback) => {
                  processPackages(content.packages, context, callback)
                })
              }
              if (processSelfQueue.length) {
                async.parallel(processSelfQueue, callback)
              } else {
                callback()
              }
            }
          ], (err) => {
            callback(err === RESOLVE_IGNORED_ERR ? null : err)
          })
        }, callback)
      } else {
        callback()
      }
    }

    const getOtherConfig = (config) => {
      let result = {}
      let blackListMap = {
        tarRoot: true,
        srcRoot: true,
        root: true,
        pages: true
      }
      for (let key in config) {
        if (!blackListMap[key]) {
          result[key] = config[key]
        }
      }
      return result
    }

    const recordIndependent = (root, request) => {
      this._module && this._module.addPresentationalDependency(new RecordIndependentDependency(root, request))
    }

    const processIndependent = (otherConfig, context, tarRoot, callback) => {
      // 支付宝不支持独立分包，无需处理
      const independent = otherConfig.independent
      if (!independent || mode === 'ali') {
        delete otherConfig.independent
        return callback()
      }
      // independent配置为字符串时视为init module
      if (typeof independent === 'string') {
        otherConfig.independent = true
        resolve(context, independent, this, (err, result) => {
          if (err) return callback(err)
          recordIndependent(tarRoot, result)
          callback()
        })
      } else {
        recordIndependent(tarRoot, true)
        callback()
      }
    }

    // 为了获取资源的所属子包，该函数需串行执行
    const processSubPackage = (subPackage, context, callback) => {
      if (subPackage) {
        if (typeof subPackage.root === 'string' && subPackage.root.startsWith('.')) {
          emitError(`Current subpackage root [${subPackage.root}] is not allow starts with '.'`)
          return callback()
        }
        let tarRoot = subPackage.tarRoot || subPackage.root || ''
        let srcRoot = subPackage.srcRoot || subPackage.root || ''
        if (!tarRoot || subPackagesCfg[tarRoot]) return callback()

        context = path.join(context, srcRoot)
        const otherConfig = getOtherConfig(subPackage)
        subPackagesCfg[tarRoot] = {
          root: tarRoot,
          pages: []
        }
        async.parallel([
          (callback) => {
            processIndependent(otherConfig, context, tarRoot, callback)
          },
          (callback) => {
            processPages(subPackage.pages, context, tarRoot, callback)
          },
          (callback) => {
            processPlugins(subPackage.plugins, context, tarRoot, callback)
          }
        ], (err) => {
          if (err) return callback(err)
          Object.assign(subPackagesCfg[tarRoot], otherConfig)
          callback()
        })
      } else {
        callback()
      }
    }

    const processSubPackages = (subPackages, context, callback) => {
      if (subPackages) {
        async.each(subPackages, (subPackage, callback) => {
          processSubPackage(subPackage, context, callback)
        }, callback)
      } else {
        callback()
      }
    }

    const processTabBar = (output) => {
      let tabBarCfg = config[mode].tabBar
      let itemKey = tabBarCfg.itemKey
      let iconKey = tabBarCfg.iconKey
      let activeIconKey = tabBarCfg.activeIconKey

      if (json.tabBar && json.tabBar[itemKey]) {
        json.tabBar[itemKey].forEach((item, index) => {
          if (item[iconKey] && isUrlRequest(item[iconKey])) {
            output += `json.tabBar.${itemKey}[${index}].${iconKey} = require("${addQuery(urlToRequest(item[iconKey]), { useLocal: true })}");\n`
          }
          if (item[activeIconKey] && isUrlRequest(item[activeIconKey])) {
            output += `json.tabBar.${itemKey}[${index}].${activeIconKey} = require("${addQuery(urlToRequest(item[activeIconKey]), { useLocal: true })}");\n`
          }
        })
      }
      return output
    }

    const processOptionMenu = (output) => {
      let optionMenuCfg = config[mode].optionMenu
      if (optionMenuCfg && json.optionMenu) {
        let iconKey = optionMenuCfg.iconKey
        if (json.optionMenu[iconKey] && isUrlRequest(json.optionMenu[iconKey])) {
          output += `json.optionMenu.${iconKey} = require("${addQuery(urlToRequest(json.optionMenu[iconKey]), { useLocal: true })}");\n`
        }
      }
      return output
    }

    const processThemeLocation = (output) => {
      if (json.themeLocation && isUrlRequest(json.themeLocation)) {
        const requestString = getRequestString('json', { src: urlToRequest(json.themeLocation) }, {
          isTheme: true,
          isStatic: true
        })
        output += `json.themeLocation = require(${requestString});\n`
      }
      return output
    }

    const processWorkers = (workers, context, callback) => {
      if (workers) {
        let workersPath = path.join(context, workers)
        this.addContextDependency(workersPath)
        copydir(workersPath, context, callback)
      } else {
        callback()
      }
    }

    const processCustomTabBar = (tabBar, context, callback) => {
      if (tabBar && tabBar.custom) {
        processComponent('./custom-tab-bar/index', context, { outputPath: 'custom-tab-bar/index' }, (err, entry) => {
          if (err === RESOLVE_IGNORED_ERR) {
            delete tabBar.custom
            return callback()
          }
          tabBar.custom = entry // hack for javascript parser call hook.
          callback(err)
        })
      } else {
        callback()
      }
    }

    const processPluginGenericsImplementation = (plugin, context, tarRoot, callback) => {
      if (!plugin.genericsImplementation) return callback()
      const relativePath = useRelativePath ? publicPath + tarRoot : ''
      async.eachOf(plugin.genericsImplementation, (genericComponents, name, callback) => {
        async.eachOf(genericComponents, (genericComponentPath, name, callback) => {
          processComponent(genericComponentPath, context, {
            tarRoot,
            relativePath
          }, (err, entry) => {
            if (err === RESOLVE_IGNORED_ERR) {
              delete genericComponents[name]
              return callback()
            }
            if (err) return callback(err)
            genericComponents[name] = entry
          })
        }, callback)
      }, callback)
    }

    const processPluginExport = (plugin, context, tarRoot, callback) => {
      if (!plugin.export) return callback()
      processJsExport(plugin.export, context, tarRoot, (err, entry) => {
        if (err === RESOLVE_IGNORED_ERR) {
          delete plugin.export
          return callback()
        }
        if (err) return callback(err)
        plugin.export = entry
        callback()
      })
    }

    const processPlugins = (plugins, context, tarRoot = '', callback) => {
      if (mode !== 'wx' || !plugins) return callback() // 目前只有微信支持导出到插件
      async.eachOf(plugins, (plugin, name, callback) => {
        async.parallel([
          (callback) => {
            processPluginGenericsImplementation(plugin, context, tarRoot, callback)
          },
          (callback) => {
            processPluginExport(plugin, context, tarRoot, callback)
          }
        ], callback)
      }, callback)
    }

    async.parallel([
      (callback) => {
        // 添加首页标识
        if (json.pages && json.pages[0]) {
          if (typeof json.pages[0] !== 'string') {
            json.pages[0].src = addQuery(json.pages[0].src, { isFirst: true })
          } else {
            json.pages[0] = addQuery(json.pages[0], { isFirst: true })
          }
        }
        processPages(json.pages, this.context, '', callback)
      },
      (callback) => {
        processComponents(json.usingComponents, this.context, callback)
      },
      (callback) => {
        processPlugins(json.plugins, this.context, '', callback)
      },
      (callback) => {
        processWorkers(json.workers, this.context, callback)
      },
      (callback) => {
        processPackages(json.packages, this.context, callback)
      },
      (callback) => {
        processCustomTabBar(json.tabBar, this.context, callback)
      },
      (callback) => {
        processSubPackages(json.subPackages || json.subpackages, this.context, callback)
      }
    ], (err) => {
      if (err) return callback(err)
      delete json.packages
      delete json.subpackages
      delete json.subPackages
      json.pages = localPages
      for (let root in subPackagesCfg) {
        const subPackageCfg = subPackagesCfg[root]
        // 分包不存在 pages，输出 subPackages 字段会报错
        if (subPackageCfg.pages.length) {
          if (!json.subPackages) {
            json.subPackages = []
          }
          json.subPackages.push(subPackageCfg)
        }
      }
      const processOutput = (output) => {
        output = processDynamicEntry(output)
        output = processTabBar(output)
        output = processOptionMenu(output)
        output = processThemeLocation(output)
        return output
      }
      callback(null, processOutput)
    })
  } else {
    // page.json或component.json
    const processGenerics = (generics, context, callback) => {
      if (generics) {
        async.eachOf(generics, (generic, name, callback) => {
          if (generic.default) {
            processComponent(generic.default, context, { relativePath }, (err, entry) => {
              if (err === RESOLVE_IGNORED_ERR) {
                delete generic.default
                return callback()
              }
              if (err) return callback(err)
              generic.default = entry
              callback()
            })
          } else {
            callback()
          }
        }, callback)
      } else {
        callback()
      }
    }
    async.parallel([
      (callback) => {
        processComponents(json.usingComponents, this.context, callback)
      },
      (callback) => {
        processGenerics(json.componentGenerics, this.context, callback)
      }
    ], (err) => {
      callback(err, processDynamicEntry)
    })
  }
}