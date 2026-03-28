onRecordCreateRequest((e) => {

    const user = e.auth;

    if (user) {
        e.record.set("owner", user.id);
    }

    e.next()

}, "objects")