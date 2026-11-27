export const COPL_RUNTIME_C = String.raw`
typedef struct {
    void* data;
    size_t len;
    size_t elem_size;
} copl_array;

static void copl_panic(const char* message) {
    fprintf(stderr, "copl runtime error: %s\n", message);
    abort();
}

typedef void (*copl_trace_fn)(void* object, size_t size);

typedef struct copl_type_descriptor {
    int kind;
    size_t size;
    size_t elem_size;
    copl_trace_fn trace;
    void (*cleanup)(void*);
} copl_type_descriptor;

#define COPL_TYPE_CLASS 1
#define COPL_TYPE_ARRAY 2
#define COPL_GC_MAGIC 0x434F504C

typedef struct copl_gc_header {
    struct copl_gc_header* next;
    const copl_type_descriptor* descriptor;
    size_t size;
    uint32_t mark;
    uint32_t magic;
} copl_gc_header;

static const copl_type_descriptor copl_desc_primitive_array = {
    COPL_TYPE_ARRAY,
    0,
    1,
    NULL,
    NULL
};

static pthread_mutex_t copl_gc_mutex = PTHREAD_MUTEX_INITIALIZER;
static copl_gc_header* copl_gc_heap = NULL;
static size_t copl_gc_allocations = 0;
static size_t copl_gc_threshold = 1024;
static int copl_gc_active_tasks = 0;
static bool copl_gc_collecting = false;

typedef struct {
    void* slot;
    bool is_array;
} copl_gc_root;

static copl_gc_root* copl_gc_roots = NULL;
static size_t copl_gc_root_count_value = 0;
static size_t copl_gc_root_capacity = 0;

typedef struct {
    size_t root_count;
} copl_gc_frame;

static void copl_gc_mark_object(void* object);
static void copl_gc_mark_array(copl_array array);

static copl_gc_header* copl_gc_header_of(void* payload) {
    return ((copl_gc_header*)payload) - 1;
}

static void copl_gc_mark_object(void* object) {
    if (object == NULL) {
        return;
    }
    copl_gc_header* header = copl_gc_header_of(object);
    if (header->magic != COPL_GC_MAGIC || header->mark != 0) {
        return;
    }
    header->mark = 1;
    if (header->descriptor != NULL && header->descriptor->trace != NULL) {
        header->descriptor->trace(object, header->size);
    }
}

static void copl_gc_mark_array(copl_array array) {
    if (array.data != NULL) {
        copl_gc_mark_object(array.data);
    }
}

static copl_gc_header* copl_gc_detach_dead_locked(void) {
    copl_gc_header* dead = NULL;
    copl_gc_header** link = &copl_gc_heap;
    while (*link != NULL) {
        copl_gc_header* header = *link;
        if (header->mark != 0) {
            header->mark = 0;
            link = &header->next;
        } else {
            *link = header->next;
            header->next = dead;
            dead = header;
        }
    }
    return dead;
}

static void copl_gc_safepoint(void) {
    pthread_mutex_lock(&copl_gc_mutex);
    if (copl_gc_collecting) {
        pthread_mutex_unlock(&copl_gc_mutex);
        return;
    }
    if (copl_gc_active_tasks == 0 && copl_gc_allocations >= copl_gc_threshold) {
        size_t cleanup_count = 0;
        for (copl_gc_header* header = copl_gc_heap; header != NULL; header = header->next) {
            if (header->descriptor != NULL && header->descriptor->cleanup != NULL) {
                cleanup_count += 1;
            }
        }
        copl_gc_header** cleanup_objects = NULL;
        if (cleanup_count > 0) {
            cleanup_objects = (copl_gc_header**)malloc(cleanup_count * sizeof(copl_gc_header*));
            if (cleanup_objects == NULL) {
                copl_panic("out of memory");
            }
            size_t cleanup_index = 0;
            for (copl_gc_header* header = copl_gc_heap; header != NULL; header = header->next) {
                if (header->descriptor != NULL && header->descriptor->cleanup != NULL) {
                    cleanup_objects[cleanup_index] = header;
                    cleanup_index += 1;
                }
            }
        }

        copl_gc_allocations = 0;
        copl_gc_collecting = true;
        pthread_mutex_unlock(&copl_gc_mutex);
        for (size_t index = 0; index < cleanup_count; index += 1) {
            copl_gc_header* header = cleanup_objects[index];
            header->descriptor->cleanup((void*)(header + 1));
        }
        free(cleanup_objects);
        pthread_mutex_lock(&copl_gc_mutex);

        for (size_t index = 0; index < copl_gc_root_count_value; index += 1) {
            copl_gc_root root = copl_gc_roots[index];
            if (root.slot == NULL) {
                continue;
            }
            if (root.is_array) {
                copl_gc_mark_array(*(copl_array*)root.slot);
            } else {
                copl_gc_mark_object(*(void**)root.slot);
            }
        }
        copl_gc_header* dead = copl_gc_detach_dead_locked();
        while (dead != NULL) {
            copl_gc_header* header = dead;
            dead = dead->next;
            free(header);
        }
        copl_gc_collecting = false;
    }
    pthread_mutex_unlock(&copl_gc_mutex);
}

static void copl_gc_push_root(void* slot, bool is_array) {
    pthread_mutex_lock(&copl_gc_mutex);
    if (copl_gc_root_count_value == copl_gc_root_capacity) {
        size_t capacity = copl_gc_root_capacity == 0 ? 64 : copl_gc_root_capacity * 2;
        copl_gc_root* roots = (copl_gc_root*)realloc(
            copl_gc_roots,
            capacity * sizeof(copl_gc_root)
        );
        if (roots == NULL) {
            copl_panic("out of memory");
        }
        copl_gc_roots = roots;
        copl_gc_root_capacity = capacity;
    }
    copl_gc_roots[copl_gc_root_count_value].slot = slot;
    copl_gc_roots[copl_gc_root_count_value].is_array = is_array;
    copl_gc_root_count_value += 1;
    pthread_mutex_unlock(&copl_gc_mutex);
}

static size_t copl_gc_root_count(void) {
    pthread_mutex_lock(&copl_gc_mutex);
    size_t count = copl_gc_root_count_value;
    pthread_mutex_unlock(&copl_gc_mutex);
    return count;
}

static void copl_gc_pop_roots_to(size_t count) {
    pthread_mutex_lock(&copl_gc_mutex);
    if (count < copl_gc_root_count_value) {
        copl_gc_root_count_value = count;
    }
    pthread_mutex_unlock(&copl_gc_mutex);
}

static copl_gc_frame copl_gc_frame_enter(void) {
    copl_gc_frame frame;
    frame.root_count = copl_gc_root_count();
    return frame;
}

static void copl_gc_frame_leave(copl_gc_frame* frame) {
    copl_gc_pop_roots_to(frame->root_count);
}

static void copl_gc_task_begin(void) {
    pthread_mutex_lock(&copl_gc_mutex);
    copl_gc_active_tasks += 1;
    pthread_mutex_unlock(&copl_gc_mutex);
}

static void copl_gc_task_end(void) {
    pthread_mutex_lock(&copl_gc_mutex);
    if (copl_gc_active_tasks > 0) {
        copl_gc_active_tasks -= 1;
    }
    pthread_mutex_unlock(&copl_gc_mutex);
}

static void* copl_gc_alloc_raw(size_t size, const copl_type_descriptor* descriptor) {
    pthread_mutex_lock(&copl_gc_mutex);
    copl_gc_header* header = (copl_gc_header*)calloc(1, sizeof(copl_gc_header) + size);
    if (header == NULL) {
        pthread_mutex_unlock(&copl_gc_mutex);
        copl_panic("out of memory");
    }
    header->next = copl_gc_heap;
    header->descriptor = descriptor;
    header->size = size;
    header->magic = COPL_GC_MAGIC;
    copl_gc_heap = header;
    copl_gc_allocations += 1;
    pthread_mutex_unlock(&copl_gc_mutex);
    return (void*)(header + 1);
}

static void* copl_gc_alloc_object(size_t size, const copl_type_descriptor* descriptor) {
    return copl_gc_alloc_raw(size, descriptor);
}

static void* copl_gc_alloc_array_raw(
    size_t len,
    size_t elem_size,
    const copl_type_descriptor* descriptor
) {
    if (len == 0 || elem_size == 0) {
        return NULL;
    }
    if (descriptor == NULL) {
        descriptor = &copl_desc_primitive_array;
    }
    return copl_gc_alloc_raw(len * elem_size, descriptor);
}

static copl_array copl_array_empty(size_t elem_size) {
    copl_array result;
    result.data = NULL;
    result.len = 0;
    result.elem_size = elem_size;
    return result;
}

static copl_array copl_array_alloc_with(
    size_t len,
    size_t elem_size,
    const copl_type_descriptor* descriptor
) {
    copl_array result;
    result.len = len;
    result.elem_size = elem_size;
    result.data = copl_gc_alloc_array_raw(len, elem_size, descriptor);
    return result;
}

static copl_array copl_array_alloc(size_t len, size_t elem_size) {
    return copl_array_alloc_with(len, elem_size, &copl_desc_primitive_array);
}

static size_t copl_array_bounds(copl_array array, int64_t index) {
    if (index < 0 || (uint64_t)index >= (uint64_t)array.len) {
        copl_panic("array index out of bounds");
    }
    return (size_t)index;
}

static void* copl_array_at(copl_array array, int64_t index) {
    size_t offset = copl_array_bounds(array, index);
    return (unsigned char*)array.data + offset * array.elem_size;
}

static copl_array copl_array_copy(copl_array source) {
    if (source.data == NULL || source.len == 0 || source.elem_size == 0) {
        return copl_array_empty(source.elem_size);
    }
    copl_gc_header* header = copl_gc_header_of(source.data);
    copl_array result = copl_array_alloc_with(
        source.len,
        source.elem_size,
        header->descriptor
    );
    memcpy(result.data, source.data, source.len * source.elem_size);
    return result;
}

static bool copl_array_equal(copl_array left, copl_array right) {
    if (left.len != right.len) {
        return false;
    }
    if (left.len == 0) {
        return true;
    }
    if (left.elem_size != right.elem_size) {
        return false;
    }
    if (left.data == NULL || right.data == NULL) {
        return left.data == right.data;
    }
    return memcmp(left.data, right.data, left.len * left.elem_size) == 0;
}

static copl_array copl_string_lit(const char* text, size_t len) {
    copl_array result = copl_array_alloc_with(len + 1, 1, &copl_desc_primitive_array);
    memcpy(result.data, text, len);
    ((char*)result.data)[len] = '\0';
    result.len = len;
    return result;
}

static copl_array copl_string_from_cstr(const char* text) {
    if (text == NULL) {
        return copl_array_empty(1);
    }
    size_t len = strlen(text);
    copl_array result = copl_array_alloc_with(len + 1, 1, &copl_desc_primitive_array);
    memcpy(result.data, text, len + 1);
    result.len = len;
    return result;
}

static char* copl_array_to_cstr(copl_array value) {
    char* text = (char*)malloc(value.len + 1);
    if (text == NULL) {
        copl_panic("out of memory");
    }
    if (value.len > 0 && value.data != NULL) {
        memcpy(text, value.data, value.len);
    }
    text[value.len] = '\0';
    return text;
}

static copl_array copl_env(copl_array name) {
    char* key = copl_array_to_cstr(name);
    const char* value = getenv(key);
    free(key);
    if (value == NULL) {
        return copl_array_empty(1);
    }
    return copl_string_from_cstr(value);
}

static void copl_env_default(copl_array name, copl_array value) {
    char* key = copl_array_to_cstr(name);
    if (getenv(key) == NULL) {
        char* text = copl_array_to_cstr(value);
        setenv(key, text, 1);
        free(text);
    }
    free(key);
}

static copl_array copl_args_from_main(int argc, char** argv) {
    copl_array result = copl_array_alloc((size_t)argc, sizeof(int64_t));
    int64_t* values = (int64_t*)result.data;
    for (int index = 0; index < argc; index += 1) {
        values[index] = (int64_t)strtoll(argv[index], NULL, 10);
    }
    return result;
}

typedef struct {
    unsigned char* data;
    size_t len;
    size_t capacity;
    size_t elem_size;
} copl_array_builder;

static void copl_array_builder_init(copl_array_builder* builder, size_t elem_size, size_t capacity) {
    builder->elem_size = elem_size;
    builder->len = 0;
    builder->capacity = capacity;
    builder->data = NULL;
    if (capacity > 0 && elem_size > 0) {
        builder->data = (unsigned char*)malloc(capacity * elem_size);
        if (builder->data == NULL) {
            copl_panic("out of memory");
        }
    }
}

static void copl_array_builder_reserve(copl_array_builder* builder, size_t extra) {
    size_t needed = builder->len + extra;
    if (needed <= builder->capacity) {
        return;
    }
    size_t capacity = builder->capacity == 0 ? 8 : builder->capacity;
    while (capacity < needed) {
        capacity *= 2;
    }
    unsigned char* data = (unsigned char*)realloc(builder->data, capacity * builder->elem_size);
    if (data == NULL) {
        copl_panic("out of memory");
    }
    builder->data = data;
    builder->capacity = capacity;
}

static void copl_array_builder_push(copl_array_builder* builder, const void* value) {
    copl_array_builder_reserve(builder, 1);
    memcpy(builder->data + builder->len * builder->elem_size, value, builder->elem_size);
    builder->len += 1;
}

static void copl_array_builder_append(copl_array_builder* builder, copl_array source) {
    if (source.len == 0 || source.data == NULL) {
        return;
    }
    if (source.elem_size != builder->elem_size) {
        copl_panic("array element size mismatch");
    }
    copl_array_builder_reserve(builder, source.len);
    memcpy(
        builder->data + builder->len * builder->elem_size,
        source.data,
        source.len * source.elem_size
    );
    builder->len += source.len;
}

static void copl_array_builder_zero(copl_array_builder* builder, size_t count) {
    if (count == 0) {
        return;
    }
    copl_array_builder_reserve(builder, count);
    memset(
        builder->data + builder->len * builder->elem_size,
        0,
        count * builder->elem_size
    );
    builder->len += count;
}

static copl_array copl_array_builder_finish(
    copl_array_builder* builder,
    const copl_type_descriptor* descriptor
) {
    copl_array result = copl_array_alloc_with(
        builder->len,
        builder->elem_size,
        descriptor
    );
    if (builder->len > 0 && builder->data != NULL) {
        memcpy(
            result.data,
            builder->data,
            builder->len * builder->elem_size
        );
    }
    free(builder->data);
    builder->data = NULL;
    builder->len = 0;
    builder->capacity = 0;
    return result;
}

typedef struct copl_task {
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    pthread_t thread;
    bool done;
    bool detached;
    bool dedicated;
    void* result;
    void* (*function)(void*);
    void* argument;
    struct copl_task* next;
} copl_task;

static void copl_task_execute(copl_task* task) {
    void* result = task->function(task->argument);
    pthread_mutex_lock(&task->mutex);
    task->result = result;
    task->done = true;
    pthread_cond_broadcast(&task->condition);
    pthread_mutex_unlock(&task->mutex);
    copl_gc_task_end();
}

static void* copl_task_entry(void* raw) {
    copl_task_execute((copl_task*)raw);
    return NULL;
}

typedef struct {
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    pthread_t* threads;
    size_t count;
    copl_task* head;
    copl_task* tail;
} copl_task_pool;

static copl_task_pool copl_pool;
static pthread_once_t copl_pool_once = PTHREAD_ONCE_INIT;

static int copl_pool_worker_count(void) {
#ifdef COPL_WORKERS_ENV
    const char* raw = getenv(COPL_WORKERS_ENV);
    if (raw != NULL && raw[0] != '\0') {
        char* end = NULL;
        long value = strtol(raw, &end, 10);
        if (end != NULL && end[0] == '\0' && value >= 1 && value <= 1024) {
            return (int)value;
        }
    }
#endif
    return COPL_DEFAULT_WORKERS;
}

static void* copl_pool_worker(void* raw) {
    (void)raw;
    for (;;) {
        pthread_mutex_lock(&copl_pool.mutex);
        while (copl_pool.head == NULL) {
            pthread_cond_wait(&copl_pool.condition, &copl_pool.mutex);
        }
        copl_task* task = copl_pool.head;
        copl_pool.head = task->next;
        if (copl_pool.head == NULL) {
            copl_pool.tail = NULL;
        }
        pthread_mutex_unlock(&copl_pool.mutex);
        copl_task_execute(task);
    }
    return NULL;
}

static void copl_pool_initialize(void) {
    pthread_mutex_init(&copl_pool.mutex, NULL);
    pthread_cond_init(&copl_pool.condition, NULL);
    int count = copl_pool_worker_count();
    if (count < 1) {
        count = 1;
    }
    copl_pool.count = (size_t)count;
    copl_pool.threads = (pthread_t*)calloc((size_t)count, sizeof(pthread_t));
    if (copl_pool.threads == NULL) {
        copl_panic("out of memory");
    }
    for (int index = 0; index < count; index += 1) {
        if (pthread_create(&copl_pool.threads[index], NULL, copl_pool_worker, NULL) != 0) {
            copl_panic("failed to start worker pool");
        }
    }
}

static void copl_pool_submit(copl_task* task) {
    pthread_once(&copl_pool_once, copl_pool_initialize);
    pthread_mutex_lock(&copl_pool.mutex);
    task->next = NULL;
    if (copl_pool.tail == NULL) {
        copl_pool.head = task;
    } else {
        copl_pool.tail->next = task;
    }
    copl_pool.tail = task;
    pthread_cond_signal(&copl_pool.condition);
    pthread_mutex_unlock(&copl_pool.mutex);
}

static copl_task* copl_task_start(void* (*function)(void*), void* argument, int workers) {
    copl_task* task = (copl_task*)calloc(1, sizeof(copl_task));
    if (task == NULL) {
        copl_panic("out of memory");
    }
    pthread_mutex_init(&task->mutex, NULL);
    pthread_cond_init(&task->condition, NULL);
    task->function = function;
    task->argument = argument;
    task->dedicated = workers > 0;
    copl_gc_task_begin();
    if (task->dedicated) {
        if (pthread_create(&task->thread, NULL, copl_task_entry, task) != 0) {
            copl_panic("failed to start task");
        }
    } else {
        copl_pool_submit(task);
    }
    return task;
}

static bool copl_task_is_done(copl_task* task) {
    pthread_mutex_lock(&task->mutex);
    bool done = task->done;
    pthread_mutex_unlock(&task->mutex);
    return done;
}

static void* copl_task_join(copl_task* task) {
    pthread_mutex_lock(&task->mutex);
    while (!task->done) {
        pthread_cond_wait(&task->condition, &task->mutex);
    }
    void* result = task->result;
    bool detached = task->detached;
    bool dedicated = task->dedicated;
    pthread_mutex_unlock(&task->mutex);
    if (dedicated && !detached) {
        pthread_join(task->thread, NULL);
    }
    return result;
}

static void copl_task_detach(copl_task* task) {
    pthread_mutex_lock(&task->mutex);
    task->detached = true;
    bool dedicated = task->dedicated;
    pthread_mutex_unlock(&task->mutex);
    if (dedicated) {
        pthread_detach(task->thread);
    }
}
`;
