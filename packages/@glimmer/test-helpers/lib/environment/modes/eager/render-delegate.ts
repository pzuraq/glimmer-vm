import {
  BundleCompilationResult,
  BundleCompiler,
  DebugConstants,
  ModuleLocatorMap,
} from '@glimmer/bundle-compiler';
import {
  ComponentCapabilities,
  ComponentDefinition,
  ComponentManager,
  Cursor,
  Dict,
  Environment,
  Helper as GlimmerHelper,
  ModuleLocator,
  ProgramSymbolTable,
  RenderResult,
  TemplateMeta,
  AotRuntimeContext,
  ConstantPool,
  ElementBuilder,
} from '@glimmer/interfaces';
import { UpdatableReference } from '@glimmer/object-reference';
import { WrappedBuilder } from '@glimmer/opcode-compiler';
import { PathReference } from '@glimmer/reference';
import {
  clientBuilder,
  getDynamicVar,
  renderAotComponent,
  renderAotMain,
  renderSync,
  AotRuntime,
} from '@glimmer/runtime';
import { assert, assign, expect, Option } from '@glimmer/util';
import { SimpleElement, SimpleDocument } from '@simple-dom/interface';
import { ComponentKind } from '../../../interfaces';
import RenderDelegate from '../../../render-delegate';
import { locatorFor, TestComponentDefinitionState } from '../../component-definition';
import { WrappedLocator } from '../../components';
import { BasicComponent, BasicComponentManager, BASIC_CAPABILITIES } from '../../components/basic';
import {
  EmberishCurlyComponent,
  EmberishCurlyComponentManager,
  EMBERISH_CURLY_CAPABILITIES,
} from '../../components/emberish-curly';
import {
  EmberishGlimmerComponent,
  EmberishGlimmerComponentManager,
  EMBERISH_GLIMMER_CAPABILITIES,
} from '../../components/emberish-glimmer';
import { HelperReference, UserHelper } from '../../helper';
import TestMacros from '../../macros';
import {
  TestModifierConstructor,
  TestModifierDefinitionState,
  TestModifierManager,
} from '../../modifier';
import EagerCompilerDelegate, { EagerCompilerRegistry } from './compiler-delegate';
import { Modules } from './modules';
import EagerRuntimeResolver from './runtime-resolver';

export type RenderDelegateComponentDefinition = ComponentDefinition<TestComponentDefinitionState>;

type Entries<T> = { [F in ComponentKind]: Option<T> };

const COMPONENT_CLASSES: Entries<unknown> = {
  Basic: BasicComponent,
  Glimmer: EmberishGlimmerComponent,
  Dynamic: EmberishCurlyComponent,
  Curly: EmberishCurlyComponent,
  Fragment: null,
};

const COMPONENT_MANAGERS: Entries<ComponentManager> = {
  Basic: new BasicComponentManager(),
  Glimmer: new EmberishGlimmerComponentManager(),
  Dynamic: new EmberishCurlyComponentManager(),
  Curly: new EmberishCurlyComponentManager(),
  Fragment: null,
};

const COMPONENT_CAPABILITIES: Entries<ComponentCapabilities> = {
  Basic: BASIC_CAPABILITIES,
  Glimmer: EMBERISH_GLIMMER_CAPABILITIES,
  Dynamic: EMBERISH_CURLY_CAPABILITIES,
  Curly: EMBERISH_CURLY_CAPABILITIES,
  Fragment: null,
};

export default class EagerRenderDelegate implements RenderDelegate {
  static readonly isEager = true;

  protected registry = new EagerCompilerRegistry();
  protected compileTimeModules = new Modules();
  protected symbolTables = new ModuleLocatorMap<ProgramSymbolTable, ModuleLocator>();
  public constants!: DebugConstants;
  private doc: SimpleDocument;

  constructor(doc?: SimpleDocument) {
    this.registerInternalHelper('-get-dynamic-var', getDynamicVar);
    this.doc = doc || (document as SimpleDocument);
  }

  private registerInternalHelper(name: string, helper: GlimmerHelper): GlimmerHelper {
    this.registry.register(name, 'helper', { default: helper });
    return helper;
  }

  getElementBuilder(env: Environment, cursor: Cursor): ElementBuilder {
    return clientBuilder(env, cursor);
  }

  getInitialElement(): SimpleElement {
    return this.doc.createElement('div');
  }

  createElement(tagName: string): SimpleElement {
    return this.doc.createElement(tagName);
  }

  registerComponent(
    type: ComponentKind,
    testType: ComponentKind,
    name: string,
    template: string,
    Class?: unknown
  ): void {
    let module = `ui/components/${name}`;

    let ComponentClass = Class || COMPONENT_CLASSES[type];
    let manager = COMPONENT_MANAGERS[type];
    let capabilities = COMPONENT_CAPABILITIES[type];

    if (!manager || !capabilities) {
      throw new Error(`Not implemented in the Bundle Compiler yet: ${type}`);
    }

    let hasSymbolTable = testType === 'Dynamic';

    let state: TestComponentDefinitionState = {
      name,
      type,
      template,
      capabilities,
      hasSymbolTable,
      ComponentClass,
      locator: locatorFor({ module, name: 'default' }),
      // Populated by the Bundle Compiler in eager mode
      layout: null,
    };

    this.registry.addComponent(module, manager, state);
  }

  getSelf(context: unknown): UpdatableReference {
    return new UpdatableReference(context);
  }

  registerHelper(name: string, helper: UserHelper): void {
    let glimmerHelper: GlimmerHelper = args => new HelperReference(helper, args);
    this.registry.register(name, 'helper', { default: glimmerHelper });
  }

  registerModifier(name: string, ModifierClass: TestModifierConstructor): void {
    let state = new TestModifierDefinitionState(ModifierClass);
    let manager = new TestModifierManager();
    this.registry.register(name, 'modifier', { default: { manager, state } });
  }

  private addRegisteredComponents(bundleCompiler: BundleCompiler<WrappedLocator>): void {
    let { registry, compileTimeModules } = this;
    Object.keys(registry.components).forEach(key => {
      assert(
        key.indexOf('ui/components') !== -1,
        `Expected component key to start with ui/components, got ${key}.`
      );

      let { state, manager } = registry.components[key];

      let locator = locatorFor({ module: key, name: 'default' });

      let block;
      let symbolTable;

      if (state.type === 'Curly' || state.type === 'Dynamic') {
        let block = bundleCompiler.preprocess(state.template!);
        let parsedLayout = { block, referrer: locator.meta, asPartial: false };
        let wrapped = new WrappedBuilder(parsedLayout);
        bundleCompiler.addCompilableTemplate(locator, wrapped);

        compileTimeModules.register(key, 'other', {
          default: wrapped.symbolTable,
        });

        symbolTable = wrapped.symbolTable;

        this.symbolTables.set(locator, symbolTable);
      } else {
        block = bundleCompiler.add(
          locator,
          expect(state.template, 'expected component definition state to have template')
        );
        symbolTable = {
          hasEval: block.hasEval,
          symbols: block.symbols,
        };

        this.symbolTables.set(locator, symbolTable);

        compileTimeModules.register(key, 'other', {
          default: symbolTable,
        });
      }

      if (state.hasSymbolTable) {
        registry.register(key, 'component', {
          default: {
            state: assign({}, state, { symbolTable }),
            manager,
          },
        });
      } else {
        registry.register(key, 'component', {
          default: {
            state,
            manager,
          },
        });
      }
    });
  }

  private getBundleCompiler(): BundleCompiler<WrappedLocator> {
    let { compiler, constants } = getBundleCompiler(this.registry);
    this.constants = constants;

    return compiler;
  }

  getConstants(): ConstantPool {
    return this.constants.toPool();
  }

  private getRuntimeContext({
    table,
    pool,
    heap,
  }: BundleCompilationResult): AotRuntimeContext<TemplateMeta> {
    let resolver = new EagerRuntimeResolver(table, this.registry.modules, this.symbolTables);

    return AotRuntime(this.doc, { constants: pool, heap }, resolver);
  }

  renderComponent(
    name: string,
    args: Dict<PathReference<unknown>>,
    element: SimpleElement
  ): RenderResult {
    let bundleCompiler = this.getBundleCompiler();
    this.addRegisteredComponents(bundleCompiler);
    let compilationResult = bundleCompiler.compile();

    let cursor = { element, nextSibling: null };
    let runtime = this.getRuntimeContext(compilationResult);
    let builder = this.getElementBuilder(runtime.env, cursor);
    let iterator = renderAotComponent(runtime, builder, compilationResult.main, name, args);

    return renderSync(runtime.env, iterator);
  }

  renderTemplate(template: string, context: Dict<unknown>, element: SimpleElement): RenderResult {
    this.registerComponent('Glimmer', 'Glimmer', 'main', template);
    let bundleCompiler = this.getBundleCompiler();
    let locator = locatorFor({ module: 'ui/components/main', name: 'default' });
    // bundleCompiler.add(locator, template);
    this.addRegisteredComponents(bundleCompiler);

    let compilationResult = bundleCompiler.compile();

    let handle = compilationResult.table.vmHandleByModuleLocator.get(locator)!;

    let cursor = { element, nextSibling: null };
    let runtime = this.getRuntimeContext(compilationResult);
    let builder = this.getElementBuilder(runtime.env, cursor);
    let self = this.getSelf(context);

    let iterator = renderAotMain(runtime, self, builder, handle);

    return renderSync(runtime.env, iterator);
  }
}

function getBundleCompiler(
  registry: EagerCompilerRegistry
): { compiler: BundleCompiler<WrappedLocator>; constants: DebugConstants } {
  let delegate: EagerCompilerDelegate = new EagerCompilerDelegate(registry);
  let constants = new DebugConstants();
  let compiler = new BundleCompiler<WrappedLocator>(delegate, {
    macros: new TestMacros(),
    constants,
  });
  return { constants, compiler };
}
