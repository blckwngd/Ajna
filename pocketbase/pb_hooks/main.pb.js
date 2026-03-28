onRecordAfterCreateSuccess((e) => {
    // e.app
    // e.record
    console.log("Test!");
     const user = e.auth; // aktuell eingeloggter User

    if (user) {
        e.record.set("owner", user.id);
        console.log("Setting id to " + user.id);
        e.record.set("owner", user.id);
    }
    e.next()
}, "objects")